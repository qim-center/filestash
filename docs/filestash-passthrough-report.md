# Filestash — Password Pass-Through Implementation & Security Report

## 1. Overview

Filestash (this fork adds a *Volume explorer* on top of the upstream project) supports
**pass-through authentication** via a server-side plugin named `passthrough`. The idea:
Filestash does **not** authenticate users itself. Instead, it collects credentials
(a password, or username + password) from the user and *passes them through* the
**attribute mapping** layer, where templates like `{{ .password }}` and `{{ .user }}`
inject them into the backend connection parameters. For the SFTP backend, those
credentials are then used to open a real SSH/SFTP connection.

Key files:

| Concern | Location |
| --- | --- |
| Passthrough auth plugin | `server/plugin/plg_authenticate_passthrough/index.go` |
| Auth middleware flow (4 steps) | `server/ctrl/session.go` (`SessionAuthMiddleware`, line 279) |
| Authentication plugin interface | `server/common/types.go` (`IAuthentication`, line 24) |
| Plugin registration | `server/plugin/index.go` (import) + `common/plugin.go` (`Hooks.Register.AuthenticationMiddleware`) |
| Route | `server/routes.go:32` → `GET/POST /api/session/auth/` |
| Attribute mapping / templates | `server/ctrl/tmpl.go` (`TmplExec`, `TmplParams`) |
| Session cookie decryption | `server/middleware/session.go` (`_extractSession`) |
| Session encryption | `server/common/crypto.go` (`EncryptString`/`DecryptString`) |
| Key derivation | `server/common/constants.go` (`InitSecretDerivate`, line 72) |
| SFTP backend using the credentials | `server/plugin/plg_backend_sftp/index.go` (`Sftp.Init`, line 44) |
| Frontend entry point | `public/assets/pages/connectpage/ctrl_form.js:173` |

## 2. The IAuthentication contract

Every authentication plugin implements `IAuthentication` (`server/common/types.go:24`):

- `Setup() Form` — admin UI form for configuring the plugin.
- `EntryPoint(idpParams, req, res)` — called on `GET /api/session/auth/?action=redirect`; renders the login page.
- `Callback(formData, idpParams, res)` — called afterwards with the submitted form data; returns the values to feed into the attribute mapping.

The `passthrough` plugin registers itself in `init()`
(`server/plugin/plg_authenticate_passthrough/index.go:12`):

```go
Hooks.Register.AuthenticationMiddleware("passthrough", Passthrough{})
```

It exposes three **strategies** (selected from the admin UI, `Setup()` at line 17):

1. **`direct`** — no credentials asked. The login "page" is an HTML form that
   auto-submits with JavaScript (line 59-62). The backend is connected using
   whatever is statically configured in the attribute mapping (possibly pulled
   from environment variables).
2. **`password_only`** — renders a login page with a single password input (line 63-72),
   usable in templates as `{{ .password }}`.
3. **`username_and_password`** — username + password inputs (line 73-85), usable as
   `{{ .user }}` / `{{ .password }}`.

Unknown strategy → 404 page (line 86-88).

The `Callback` (line 93-98) trivially returns the form fields:

```go
return map[string]string{
    "user":     formData["user"],
    "password": formData["password"],
}, nil
```

Note: the plugin performs **no credential verification at all** — verification is
implicitly delegated to the backend (SSH login either succeeds or fails in Step 3).

## 3. The end-to-end flow

Frontend: when a storage uses the middleware, the connect page redirects the browser
to `api/session/auth/?action=redirect&label=<label>&state=<base64 URL params>`
(`public/assets/pages/connectpage/ctrl_form.js:171-182`).

Server-side (`SessionAuthMiddleware`, `server/ctrl/session.go:279`):

- **Step 0** (line 282-351): load the configured identity provider
  (`middleware.identity_provider.type` + `.params` from config, parsed as JSON and
  pre-evaluated once through `TmplExec`). Collect `formData` from the query string
  (GET) and/or the parsed form body (POST).
- **Step 1** (line 353-376): on `GET ...&action=redirect`, call `plugin.EntryPoint` →
  the passthrough plugin renders the login page (or the auto-submitting form for
  `direct`). A `ssoref` cookie (`label::state`, 10 min TTL, `SameSite=Lax`) is set to
  remember the label/state for the follow-up POST.
- **Step 2** (line 378-466): call `plugin.Callback` → get `{user, password}`.
  The `state` query param (base64-encoded JSON) is decoded and **merged into the
  template context**, unless the field is already present from the callback.
  If `features.protection.signature` (config) lists fields, those must be backed by a
  decrypted `signature` field (`SECRET_KEY_DERIVATE_FOR_SIGNATURE` AES-GCM check,
  line 438-450) — **but this check is only active when the option is configured
  (default is empty**, `server/common/config.go:111`).
  The final post-login redirect target comes from `templateBind["next"]` (line 460).
- **Step 3** (line 468-514): the **attribute mapping** (`middleware.attribute_mapping.params`)
  is a per-label map of field → Go text/template. For the passthrough, this is where
  the magic happens, e.g.:

  ```json
  { "mylabel": { "type": "sftp", "hostname": "10.0.0.5",
                 "username": "{{ .user }}", "password": "{{ .password }}" } }
  ```

  `TmplExec` renders each template with the merged context. The resulting `session`
  map is then passed to `model.NewBackend` (`server/model/files.go:9`), which:
  - enforces an **allow-list of connections** (`isAllowed`, line 10-45: type/hostname/path/url
    must match a configured connection — prevents the UI from being used as an
    open proxy to arbitrary hosts), then
  - calls `Sftp.Init`, which **dials SSH with the passed credentials** — this is the
    real authentication check: a wrong password returns `ErrAuthenticationFailed`,
    and the user is redirected to an error page (line 505-514).

  With `general.extended_session` enabled, the raw plugin callback (i.e. the
  **plaintext user and password**) is additionally stored under `session["session"]`
  (line 487-492).

- **Step 4** (line 516-545): the whole session map — **including the plaintext
  password** — is JSON-serialized, zlib-compressed, encrypted with AES-GCM
  (`EncryptString`, key `SECRET_KEY_DERIVATE_FOR_USER`) and set as the `auth` cookie
  (`COOKIE_NAME_AUTH`, `HttpOnly`, `SameSite=Strict`, MaxAge =
  `general.cookie_timeout`, default 1 week, `server/common/config.go:84`).
  If `features.protection.iframe` is set, the same token is also returned in a
  `bearer` response header and appended to the `#bearer=<token>` URL fragment.

On every subsequent request, `middleware/session.go:_extractSession` (line 259-312)
decrypts the cookie, unmarshals the session (password included) and checks the
`timestamp` is not older than **1 year** (line 307). `_extractBackend` then rebuilds
the SFTP connection from the session parameters (line 314-316).

## 4. How the SFTP backend consumes the credentials

`server/plugin/plg_backend_sftp/index.go:44` (`Sftp.Init`):

- Reads `hostname`, `port`, `username`, `password`, `passphrase` from the session map.
- If the value in the `password` field parses as a **PEM private key**
  (`isPrivateKey`, line 85-104), it is used as a key (optionally with a
  `passphrase`); otherwise both `ssh.Password(p.password)` and
  `ssh.KeyboardInteractive` are registered — the latter answers **every
  interactive challenge with the same password** (line 141-150).
- `HostKeyCallback`: if no `hostkey` is configured, **any host key is accepted**
  (line 156-170). Otherwise the SHA256 or legacy MD5 fingerprint must match.
- Connections are cached in a 5-minute LRU (`SftpCache`), **keyed by a hash of the
  full params map, password included** (line 16, 62, 194; `common/cache.go:16-19`).

## 5. Crypto building blocks

- `general.secret_key` is auto-generated (16 random alphanumerics) on first start
  and persisted (`server/common/config.go:251-255`).
- Per-purpose keys are derived as `Hash("<PURPOSE>_" + SECRET_KEY, len(SECRET_KEY))`
  (`common/constants.go:72-79`): `SECRET_KEY_DERIVATE_FOR_USER` is the AES-GCM key
  for user session cookies.
- `EncryptString` = zlib compress → AES-GCM (12-byte counter nonce from a
  per-process RNG-seeded counter, `common/crypto.go:22-37, 240-265`) → base64url.
  GCM gives confidentiality + integrity (authenticated encryption).

## 6. Security analysis

### 6.1 What is done well

- **Encrypted session cookie.** The password is never stored in the cookie in
  plaintext; it is AES-GCM (authenticated encryption) with a key derived from the
  server secret. Compromise of the cookie alone does not yield the password (attacker
  would also need `general.secret_key`).
- **Per-purpose key derivation** user/admin/proof/signature keys are separated,
  limiting cross-endpoint token reuse.
- **Cookie flags**: `HttpOnly` + `SameSite=Strict` on the session cookie
  (`ctrl/session.go:548-561`) — mitigates XSS token theft and CSRF form submission
  against the auth endpoint.
- **XSS hardening of the login page**: `label` and `state` are passed through
  `html.EscapeString` before being embedded in the generated HTML
  (`plg_authenticate_passthrough/index.go:54-55`), and `Page()`'s auto-fill script
  sets `element.value` (not `innerHTML`), so parameter values cannot inject script.
- **Credential exclusion from identifiers**: `GenerateID` explicitly skips
  `password`/`path`/`session`/`timestamp` when computing the backend ID
  (`common/crypto.go:193-218`), so session identifiers, share ownership checks and
  audit entries do not leak the password.
- **Audit hygiene**: login/logout audit lines record only username, backend ID and
  IP (`ctrl/session.go:187, 238, 507-508`); the password is not logged anywhere.
- **Connection allow-list**: `model.NewBackend` refuses backends whose
  type/hostname/path/url don't match a configured connection (`model/files.go:10-49`),
  which prevents the pass-through login form from being weaponized to connect to
  arbitrary internal/external hosts (SSRF-style abuse).
- **Real verification still happens**: even though the plugin "passes through", the
  SSH handshake in Step 3 must succeed, so wrong credentials are rejected and the
  backend error can be surfaced.
- **HSTS support** when `general.force_ssl` is set (`middleware/http.go:64-74`).
- **Compression-after-encryption is not an issue here** (compress-then-encrypt is
  the safe order), and GCM authenticates the ciphertext.

### 6.2 Risks and weaknesses

1. **`direct` strategy = no authentication at all.** Anyone who can reach the
   Filestash URL gets a session as the *configured* identity (mapping may pull
   credentials from environment variables — `TmplParams` exposes all `ENV_*` vars,
   `ctrl/tmpl.go:40-53`). There is no rate limiting or gate on
   `GET /api/session/auth/?action=redirect`. Use of `direct` effectively means an
   open door to the mapped account.

2. **No rate limiting on the auth middleware route.** The generic login endpoint
   `POST /api/session` gets a `RateLimiter` (10 req/s, `routes.go:26-27`), but
   `/api/session/auth/` is registered **without** one (`routes.go:32`).
   Brute-force of an SFTP password through the passthrough form is only implicitly
   throttled by the cost of each SSH dial; there is no per-IP throttling, lockout or
   lockout-free failure signalling beyond a redirect.

3. **Plaintext password on the wire at login time.** The form POSTs `user`/`password`
   as an unencrypted form body to `/api/session/auth/`. Only TLS protects it. If
   Filestash is deployed without `force_ssl`/TLS, credentials are readable by a
   network attacker (the cookie, by contrast, is encrypted).

4. **Long-lived embedded password.** The decrypted session (password included) stays
   in the `auth` cookie for `general.cookie_timeout` (default **7 days**), and the
   server accepts it for up to **a year** after the session `timestamp`
   (`middleware/session.go:307`). Combined with the 5-minute in-memory SFTP cache
   keyed by the full params (password included), the credential lives for long
   periods in the browser and in server memory. There is no ticket exchange after the
   first successful SSH login — the raw password is re-used for the whole session
   lifetime.

5. **`state` (URL) injection without signature by default.** The base64 `state`
   parameter is merged into the template context and supplies the post-login
   `next` redirect. Verification of those values only happens if
   `features.protection.signature` is configured (default: empty → **no check**).
   Consequences: open/post-login redirect to attacker-chosen URLs and ability to
   override template mapping values not set by the form (e.g. `path`).

6. **URL parameters are auto-filled into the login form.** `Page()` injects a script
   that copies *every* query-string parameter into matching form fields
   (`common/response.go:111-114`). A crafted link
   `.../api/session/auth/?action=redirect&user=admin&password=...` pre-fills
   credentials in the visible form (phishing/credential-reuse vector) and keeps
   those values in the URL, browser history and access logs.

7. **SFTP host key verification is opt-in.** When `hostkey` is not configured,
   `HostKeyCallback` accepts **any** server key (`plg_backend_sftp/index.go:156-170`).
   An active MITM on the path to the SSH server can then capture the password
   (which is sent clear-text inside the SSH userauth exchange to the fake host).

8. **Keyboard-interactive answers every prompt with the same password**
   (`plg_backend_sftp/index.go:143-149`) — fine for a single password, but it means
   e.g. a "username: / password:" challenge flow will reuse the password as the
   username answer too, which can fail or leak the secret in odd configurations.

9. **Private keys travel as the "password".** If the `password` field holds a PEM
   key (or key material), the same pipeline applies — form POST, env mapping,
   cookie, cache key — so a private key enjoys exactly the same (in)security as a
   password.

10. **Token duplication in iframe mode.** When `features.protection.iframe` is set,
    the full encrypted session is also emitted in the `bearer` response header and in
    the `#bearer=...` URL fragment (`ctrl/session.go:541-543`). URL fragments can be
    retained in history and shared inadvertently, expanding the exposure surface of a
    (long-lived) session token.

11. **Cookie not `Secure` by default.** `applyCookieRules` only sets `Secure` when
    iframe mode + HTTPS referer are both present (`ctrl/session.go:548-561`). Over
    plain HTTP the session cookie (encrypted payload) still travels unencrypted,
    losing the defense-in-depth provided by the AES layer.

12. **Single-fragment cookie on the middleware path.** Unlike `SessionAuthenticate`
    (which splits the payload across `auth`, `auth1`, ... to stay under ~4 KB,
    `ctrl/session.go:161-183`), the passthrough flow writes the **entire** encrypted
    token to one `auth` cookie (line 535-540). Large sessions (long PEM keys,
    extended_session embedding the raw JSON callback) risk exceeding the 4096-byte
    cookie limit and being truncated by browsers.

13. **Error reflection on failure.** On backend auth failure the user is redirected
    to `/?error=...&trace=backend error - <err>` with `err.Error()` in the URL
    (`ctrl/session.go:509-512`). Backend error text is reflected and can leak
    implementation details (e.g. SSH disconnect reason), aiding fingerprinting.

14. **Deterministic GCM nonces.** The nonce counter is random-seeded per process but
    monotonically deterministic (`common/crypto.go:240-265`). Acceptable in practice,
    but a process that keeps the same seed across restarts (seed is re-randomized per
    start, so only theoretical) would risk nonce reuse; noted for completeness.

15. **Trust placed in server-side config/env.** The attribute mapping is a template
    engine with access to `ENV_*` and helper functions (`jwt`, `decryptGCM`,
    `filter`, regex `replace`, `ctrl/tmpl.go:55-147`). This is powerful (and how
    `direct` obtains its credentials) but it means anyone with admin config access
    holds all the secrets the mapping can reach — a mis-scoped config = credential
    leak.

### 6.3 Recommendations

- Enforce TLS (`general.force_ssl`) — the login form and (non-iframe) cookies are not
  otherwise protected.
- Always set a `hostkey` fingerprint for SFTP connections to defeat MITM.
- Set `features.protection.signature` (e.g. `next,signature`) to enforce signed
  `state` parameters.
- Add a `RateLimiter` (ideally per-IP) to the `/api/session/auth/` chain.
- Prefer `password_only`/`username_and_password` over `direct`; if `direct` is
  required, put an IP allow-list/auth proxy in front of Filestash.
- Reduce `general.cookie_timeout` and the 1-year session timestamp tolerance;
  consider exchanging the password for a short-lived backend session token after the
  first successful SSH login.
- Split the middleware-path session cookie like `SessionAuthenticate` does, to avoid
  4 KB truncation with large mappings.
- Avoid putting long-lived secrets in environment variables used by the attribute
  mapping; rotate `general.secret_key` when staff/hosts change (all existing
  session cookies are invalidated on rotation, which is the intended mechanism).
- Strip/sanitize the reflected backend error in the post-login failure redirect.

## 7. Summary

The pass-through is implemented as a small `IAuthentication` plugin
(`plg_authenticate_passthrough`) whose `EntryPoint` renders a minimal HTML login page
(3 strategies), whose `Callback` forwards `user`/`password` to the generic
attribute-mapping engine. There the credentials are template-injected into the SFTP
connection parameters, an actual SSH login validates them, and the resulting session
— password in plaintext inside — is sealed with AES-GCM into an `HttpOnly`/`SameSite`
cookie for the lifetime of the session.

The core design is reasonable (real backend verification, authenticated encryption of
the cookie, XSS-safe rendering, per-purpose keys, connection allow-list, no password
in logs). The main security caveats are operational: **the `direct` strategy is
unauthenticated by design, the auth route lacks rate limiting, `state` parameters are
unsigned by default, SFTP host-key checking is opt-in, and the same raw password
persists (encrypted) for the whole session lifetime**.
