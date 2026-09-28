# Filestash — Password Passthrough (DRAFT)

> **Status:** DRAFT — for review. Findings marked *(to verify)* are based on
> code reading and should be confirmed before this becomes authoritative docs.
>
> **Scope:** How Filestash's *auth middleware* "password passthrough"
> (`plg_authenticate_passthrough`) works end-to-end, with emphasis on its
> security properties. This is the QIM Center fork of
> [Filestash](https://github.com/mickael-kerjean/filestash).

---

## 1. What "password passthrough" means here

Filestash supports many **backends** (SFTP, Samba, psql, …) and many
**identity providers / auth middlewares** (local, LDAP, htpasswd, admin,
WordPress, and **passthrough**).

The *passthrough* plugin does **not validate credentials itself**. It simply
collects the user's credentials (or none) and hands them to the backend
storage system, which is the **authoritative credential checker**. "Passthrough"
= the password flows straight through Filestash into the storage backend.

The plugin registers itself as an `IAuthentication` middleware under the id
`passthrough`:

- `server/plugin/plg_authenticate_passthrough/index.go:11-15`
- Interface: `IAuthentication` at `server/common/types.go:24-28`
- Middleware dispatch: `SessionAuthMiddleware` at `server/ctrl/session.go:279`

---

## 2. The three strategies

Configured via the `strategy` field (see `Setup()` in
`plg_authenticate_passthrough/index.go:17-37`):

| Strategy              | What happens | Credentials involved |
|-----------------------|--------------|----------------------|
| `direct`              | Redirects to storage immediately, no form shown. Uses whatever static credentials are defined in the **attribute mapping** section. | Static / config-defined |
| `password_only`       | Shows a password-only form. The value is available to the mapping as `{{ .password }}`. | User password |
| `username_and_password` | Shows a username + password form. Available as `{{ .user }}` and `{{ .password }}`. | User username + password |

`EntryPoint` renders the HTML for each strategy (`index.go:52-91`); the form
posts to `/api/session/auth/<params>`.

---

## 3. End-to-end login flow

1. **Front-end.** The connect page detects that the selected storage is an
   *auth middleware* (`conn.middleware === true`) and performs a **full-page
   redirect** (not an XHR) to
   `api/session/auth/?action=redirect&label=<label>` (with an optional
   base64 `state`).
   - `public/assets/pages/connectpage/ctrl_form.js:171-182` (`CASE 1`)
2. **Server — EntryPoint (Step 1).** `SessionAuthMiddleware` reads the
   identity-provider type from config
   (`middleware.identity_provider.type`) and calls `plugin.EntryPoint(...)`.
   It can also set a short-lived `ssoref` cookie
   (`label::state`, 10 min) when `label` is present.
   - `server/ctrl/session.go:353-376`
3. **Server — Callback (Step 2).** The browser submit posts back to
   `/api/session/auth/...`. `plugin Callback` returns
   `{"user": ..., "password": ...}`. **No validation happens here.**
   - `server/ctrl/session.go:378-401`
   - passthrough `Callback`: `plg_authenticate_passthrough/index.go:93-98`
4. **Server — attribute mapping (Step 3).** The config under
   `middleware.attribute_mapping.params` (JSON, per-`label`) is a set of Go
   `text/template` expressions evaluated against the callback values
   (`user`, `password`, `machine_id`, `ENV_*`). The result is the *session /
   connection* map — e.g. `{"type":"sftp","hostname":...,"username":"{{.user}}",
   "password":"{{ .password }}","path":...,"timestamp":...}`.
   - `server/ctrl/session.go:468-493`
   - Template engine + funcs: `server/ctrl/tmpl.go:20-38`, helper funcs
     `server/ctrl/tmpl.go:55-247`
5. **Server — backend connection (Step 3, cont.).** `model.NewBackend(ctx,
   session)` is called. First an allow-list check (`isAllowed()`) restricts
   the connection to connections defined in `Config.Conn`. Then the backend
   `Init` runs and, for SFTP, dials SSH using the mapped password.
   - `server/model/files.go:9-51`
   - SFTP init / auth: `server/plugin/plg_backend_sftp/index.go:44-196`
   - If SSH rejects the password → `ErrAuthenticationFailed` → user bounced
     back to the login form.
6. **Server — session persistence (Step 4).** The session map (which **includes
   the password**) is JSON-marshalled, **AES-GCM encrypted** with a key derived
   from the instance `secret_key`, base64url-encoded, and set into the `auth`
   cookie (also split across index cookies if large). The response 302s the
   browser to `/` (or the `next` value).
   - `server/ctrl/session.go:516-546`
7. **Subsequent requests.** `SessionStart` middleware decrypts the `auth`
   cookie back into the session and re-creates the backend (re-dialing SFTP).
   So the password effectively **lives in the cookie for the cookie's lifetime**
   and is re-used to reconnect.
   - `server/middleware/session.go:57-83`, `_extractSession` at `:259-312`

---

## 4. Where the password actually goes

| Location | Plaintext? | Notes |
|----------|------------|-------|
| Browser form → `POST /api/session/auth/` | Yes (in body) | Requires TLS (see §5) |
| `plugin Callback` → `pluginCallback` map | Yes | In-memory only |
| Attribute-mapping template input (`{{ .password }}`) | Yes | In-memory |
| `session` map (connection map) | Yes | In-memory; becomes the cookie payload |
| `auth` cookie (and split index cookies) | **No — encrypted** | AES-GCM, key derived from `secret_key` |
| `session["session"]` when `general.extended_session` is on | Yes (but inside the encrypted cookie) | Raw callback JSON explicitly retained |
| `config.json` on disk (`...attribute_mapping.params`, `...identity_provider.params`) | **No — encrypted at rest** | `server/common/config_state.go:24-30` |
| `auth.admin` (separate admin console) | bcrypt hash | Not the passthrough path |
| Audit / access log | **No** | Logs `user`, not `password` (§8) |
| SFTP/SSH connection | Yes (over TLS) | Sent to the storage backend during `Init` |

Key points:

- **Password is never stored by Filestash.** It is only *tunnelled* from the
  browser to the storage backend, plus a copy is kept (encrypted) in the
  session cookie so Filestash can reconnect later.
- **The storage backend (SSH) is the only thing that validates the password.**
  Filestash has no independent notion of "correct password" for this path.
- **`GenerateID` deliberately excludes `password`** (and `path`, `session`,
  `timestamp`) when deriving the session identity hash
  (`server/common/crypto.go:193-218`). Two sessions differing only in password
  get the *same* backend id — the password does not fingerprint the session id.

---

## 5. Transport security

- The password travels in a form `POST`. This must be protected by **TLS**;
  the app supports `general.force_ssl` (Strict-Transport-Security) —
  `server/middleware/http.go:64-74`.
- Cookies: `auth` is `HttpOnly`, `SameSite=Strict` (or `SameSite=None` +
  `Partitioned` + `Secure` when `features.protection.iframe` is set and the
  referer is https). See `applyCookieRules` at
  `server/ctrl/session.go:548-561`.
- `ssoref` is `SameSite=Lax` (10 min TTL).

> ⚠️ **Assumption:** a deployment must terminate TLS at a reverse proxy (nginx,
> etc.). If Filestash is reached over plain HTTP, the password and the
> encrypted cookie are exposed in transit. *(to verify: confirm upstream proxy
> config)*

---

## 6. Cryptographic building blocks

- **Secret key:** `general.secret_key`, `[a-zA-Z0-9]{16}`, randomly generated
  on first run (`server/common/config.go:251-255`).
- **Key derivation:** five 16-byte sub-keys via
  `Hash("USER_"+secret, 16)`, `..._FOR_PROOF`, `..._FOR_ADMIN`, etc.
  (`server/common/constants.go:72-79`). Used as **AES-128-GCM** keys
  (`server/common/crypto.go:128-164`).
- **AES-GCM** with 12-byte counter nonces (thread-safe
  `NonceGenerator`) (`server/common/crypto.go:240-265`). *Note:* a
  deterministic counter nonce is used across one process — safe under the
  assumption of a single process per key, but worth a second look. *(to
  verify: confirm no multi-process deployment shares one secret_key)*
- **Config values at rest:** `middleware.identity_provider.params` and
  `middleware.attribute_mapping.params` (which can contain static passwords)
  are AES-GCM encrypted before being written to `config.json`, keyable with
  `CONFIG_SECRET` env or derived from `secret_key`
  (`server/common/config_state.go:24-116`).

---

## 7. Authentication-flow security controls

| Control | Location | Effect |
|---------|----------|--------|
| Connection allow-list | `isAllowed()` in `server/model/files.go:10-49` | Only connections matching a defined `Config.Conn` entry (type + hostname + path prefix + url) are usable. Mitigates arbitrary-connection SSRF. *Note:* a constraint is only enforced if that field is present in the config entry. *(to verify: how strict the default config is)* |
| Host allow-list / origin check | `SecureOrigin` `server/middleware/http.go:76-102` | Blocks requests whose host doesn't match `general.host` (except admin). Requires `X-Requested-With: XmlHttpRequest` or a cookie-less API call. Also logs "Intrusion detection" on mismatch. **Not in the `/api/session/auth/` middleware chain** — see §9, finding #1. |
| Rate limiting | `RateLimiter` (10 req/s burst 1000) `server/middleware/http.go:104-118` | Applied to plain `POST /api/session` (case-3 login) and admin login. **NOT applied to `/api/session/auth/`** — see §9, finding #1. |
| State signature (optional) | `server/ctrl/session.go:422-450` | If `features.protection.signature` lists fields, the base64 `state` must carry a valid signature (AES-GCM with `..._FOR_SIGNATURE`). Mitigates parameter tampering. **Not enabled by default** — see §9, finding #3. |
| Cookie hardening | `applyCookieRules` `server/ctrl/session.go:548-561` | HttpOnly, SameSite, Path scoping, Secure when iframe+https. |
| Admin auth hardening | `AdminSessionAuthenticate` `server/ctrl/admin.go:47-84` | 1.5 s deliberate delay + bcrypt. (Admin console, not the passthrough path.) |

---

## 8. Auditing & logging

- Login success/failure are written as `AUDIT action[login|fail] backend[...]
  user[...] target[...]` to stdout/access log
  (`server/ctrl/session.go:118, 136, 144, 187, 507, 544`).
- **The password is NOT logged** — `username(session)` returns the user, not
  the password (`server/ctrl/session.go:572-579`), and the per-request telemetry
  logger records `RequestURI` (not the POST body) plus
  `GenerateID(session)` (which excludes the password)
  (`server/middleware/telemetry.go:39-89`, `server/common/crypto.go:193-218`).
- `ip(req)` prefers `X-Forwarded-For` / `X-Real-Ip`
  (`server/ctrl/session.go:581-595`), so the logged login IP is **spoofable**
  behind a proxy unless the proxy is trusted. *(to verify: is the proxy
  pinned/trusted?)*

---

## 9. Security findings & open questions

Findings ranked by how actionable they are. Each is from static reading of the
code; please confirm behaviour in a live environment.

1. **The passthrough auth endpoint lacks both rate limiting and the origin check (confirmed).**
   The middleware chain for `/api/session/auth/` (GET+POST, the passthrough
   login) is `[ApiHeaders, SecureHeaders, PluginInjector]`
   (`server/routes.go:30-31`). By comparison, the plain `POST /api/session`
   case-3 login is `[ApiHeaders, SecureHeaders, SecureOrigin, RateLimiter,
   BodyParser, PluginInjector]` (`server/routes.go:26`). So the passthrough
   path is missing **both** `RateLimiter` **and** `SecureOrigin`:
   - no per-IP throttle → an attacker can hammer the passthrough login at high
     volume (SSH may still lock out, but Filestash itself imposes none);
   - no `SecureOrigin` host check → the cross-origin / host-mismatch protection
     that `SecureOrigin` provides on the other login route does not apply here.
   *Suggestion: put the auth-middleware routes behind `RateLimiter` and add
   `SecureOrigin` to match the primary login route.*

2. **The password persists in the `auth` cookie for the cookie lifetime.**
   The default is `cookie_timeout = 60*24*7` minutes ≈ **1 week**
   (`server/common/config.go:84`). Because the session cookie embeds the
   password (encrypted) and the middleware re-dials SFTP from the cookie, a
   stolen cookie grants: (a) the live session, **and** (b) the underlying
   credential, usable directly against the SSH server for as long as it is
   valid. The encryption is only as strong as `secret_key` (128-bit base62).
   *Consider shorter cookie TTLs and/or re-auth before sensitive operations.*

3. **`state` parameter tampering is mitigated only if signature is enabled (off by default).**
   The base64 `state` (query/cookie) is decoded and merged into the template
   bindings *only if* `features.protection.signature` lists the relevant
   fields. With the default (empty) `signature`, a crafted
   `/api/session/auth/?action=redirect&label=X&state=<b64>` can inject/override
   mapping variables (e.g. `next` → open redirect; other fields not already set
   by the callback). *Recommend enabling `features.protection.signature`.*

4. **Template engine exposes the process environment.**
   `TmplParams` injects every process env var as `ENV_*` and `machine_id` into
   every mapping template (`server/ctrl/tmpl.go:40-53`). A mis-configured
   attribute mapping could leak env-var secrets (DB creds, tokens) into a
   session/connection or even echo them out. The template also offers
   `encryptGCM`/`decryptGCM`/`jwt` with arbitrary keys — a powerful (if
   admin-only) feature set. *Treat the attribute-mapping DSL as a privileged
   surface; restrict who can edit it.*

5. **Form field population from URL query params.**
   `Page()` injects a script that fills any form input from URL query params
   (`server/common/response.go:111-114`). Depending on how an SSO/redirecting
   IdP is wired, a password *could* end up in the URL and thus in the browser
   address bar, history, `Referer`, and proxy logs. *Verify the exact IdP
   wiring; prefer bodies/cookies over query strings for secrets.*

6. **`ip(req)` trusts `X-Forwarded-For`.**
   Login audit IP can be spoofed (§8). If audit trails matter for
   accountability of shared credentials, pin the trusted proxied client behind
   the app. *(to verify)*

7. **`direct` strategy + static credentials in config.**
   With `direct`, credentials come from the (encrypted) attribute mapping.
   Anyone with access to `secret_key` (or `config.json` + key) can recover
   them; the config file is otherwise world-readable. *Ensure `config.json`
   permissions and `CONFIG_SECRET` rotation policy.*

8. **Deterministic GCM nonces.**
   `NonceGenerator` uses an in-process counter
   (`server/common/crypto.go:240-265`). GCM nonce-reuse under the same key is
   catastrophic (key/IV reuse). This is safe if **one process** per
   `secret_key`; confirm no multi-worker/multi-replica setups share the same
   key without a fresh nonce source. *(to verify deployment topology)*

9. **`isAllowed()` only enforces the fields that are present in the config entry (confirmed).**
   `type` is **always** a required match. But the `hostname`, `path` (prefix),
   and `url` checks are each guarded by `if val, ok := d[...]; ok` — a config
   entry that omits a given field skips that constraint entirely
   (`server/model/files.go:16-38`). So a permissive `Config.Conn` entry (e.g.
   `{"type":"sftp"}` with no `hostname`) would accept connections to any host.
   *Ensure each intended backend entry fully specifies `hostname`/`path`/`url`.*

---

## 10. What seems solid

- Password is **never persisted in cleartext** by Filestash (encrypted cookie,
  encrypted config-at-rest, no plaintext logs).
- Password is **excluded** from the session-identity hash.
- **AES-GCM** (authenticated encryption) used consistently.
- Sensitive config sections **encrypted at rest**.
- Connection **allow-listing**, host **origin checks**, HttpOnly/SameSite
  cookies, HSTS option, and rate limiting on the primary login path.
- The storage backend is the **single source of truth** for credential
  validity — Filestash does not keep a usable credential of its own (other than
  the encrypted session copy).

---

## 11. Suggested next steps

1. Confirm live behaviour of each *(to verify)* item above.
2. Add `RateLimiter` to the `/api/session/auth/` routes.
3. Enable `features.protection.signature` in the reference config.
4. Document TLS-termination requirements and `secret_key`/`CONFIG_SECRET`
   handling.
5. Decide on a maximum `cookie_timeout` for passthrough deployments.
6. Add an explicit "secrets handling" note for the attribute-mapping DSL
   (env exposure, `decryptGCM`/`jwt`).

---

## Appendix A — Map of relevant code

| Concern | File |
|---------|------|
| Passthrough plugin (strategies, entry point, callback) | `server/plugin/plg_authenticate_passthrough/index.go` |
| Auth middleware orchestration (entry point, callback, mapping, cookie) | `server/ctrl/session.go` |
| Template engine + privileged template funcs | `server/ctrl/tmpl.go` |
| Backend allow-list + dispatch | `server/model/files.go` |
| SFTP backend (SSH password auth) | `server/plugin/plg_backend_sftp/index.go` |
| Session/cookie extraction on request | `server/middleware/session.go` |
| Security middleware (origin, rate limit, headers) | `server/middleware/http.go` |
| Crypto (AES-GCM, key derivation, IDs) | `server/common/crypto.go` |
| Secret keys | `server/common/constants.go` |
| Encrypted config-at-rest | `server/common/config_state.go` |
| Config / defaults (secret_key, cookie_timeout) | `server/common/config.go` |
| Routes (which endpoints have which middleware) | `server/routes.go` |
| Front-end login + middleware redirect | `public/assets/pages/connectpage/ctrl_form.js` |
| Front-end session model | `public/assets/model/session.js` |
| Request telemetry logger | `server/middleware/telemetry.go` |

## Appendix B — Key config settings

| Setting | Default | Relevance |
|---------|---------|-----------|
| `general.secret_key` | random `[a-zA-Z0-9]{16}` | Root key for all encryption |
| `general.cookie_timeout` | `60*24*7` (min) | How long the (password-bearing) cookie lives |
| `general.extended_session` | false | If true, raw callback (incl. password) is retained in-session |
| `general.force_ssl` | false | HSTS; TLS termination expected upstream |
| `middleware.identity_provider.type` | "" | Set to `passthrough` to enable this flow |
| `middleware.identity_provider.params` | "" (encrypted at rest) | Plugin params incl. `strategy` |
| `middleware.attribute_mapping.params` | "" (encrypted at rest) | Per-label template map; where `{{ .password }}` is wired |
| `middleware.attribute_mapping.related_backend` | "" | Lists which storage labels are middleware-driven |
| `features.protection.signature` | "" (off) | Enables state-signature tamper protection |
| `features.protection.iframe` | "" | iframe/X-Frame-Options + SameSite=None/Secure cookie mode |
