# Filestash — Credential Storage, Pass-Through Route & Session Management

## 0. How to read this report

This document answers three questions about how Filestash (this
fork) handles credentials in the SFTP pass-through flow: *is your password stored
anywhere*, *where does it travel once it is submitted*, and *how does the server
"remember" you are logged in*. 

Every claim below was checked against the code in this
repository. Key locations:

| Concern | Location |
| --- | --- |
| Passthrough auth plugin | `server/plugin/plg_authenticate_passthrough/index.go` |
| Auth middleware flow | `server/ctrl/session.go:279` (`SessionAuthMiddleware`) |
| SFTP backend (SSH dial) | `server/plugin/plg_backend_sftp/index.go:44` (`Sftp.Init`) |
| Backend allow-list | `server/model/files.go:9-51` (`NewBackend`) |
| Cookie creation | `server/ctrl/session.go:516-545`, `applyCookieRules` (548-561) |
| Cookie decryption per request | `server/middleware/session.go:259-316` |
| Token extraction (cookie/header/query) | `server/middleware/session.go:160-185` |
| Encryption primitives | `server/common/crypto.go:27-53` |
| Key derivation | `server/common/constants.go:72-79` |
| Connection cache | `server/common/cache.go:16-36`, `plg_backend_sftp/index.go:16,62,194` |
| Frontend redirect | `public/assets/pages/connectpage/ctrl_form.js:171-182` |
| Route registration | `server/routes.go:32` |

---

## 1. Is the password stored by Filestash?

### 1.1 Summary

No. Filestash does **not** write your password to disk, to the database, or to the
logs. But it does **keep** it in two places for as long as you are logged in:

1. **In your browser** — hidden inside an *encrypted* cookie that expires after a
   week by default. The password is inside that cookie, protected by
   encryption (so a stolen cookie alone is not directly readable), but the cookie
   *is* your password, in a sealed envelope.
2. **In the server's memory** — while you are using Filestash, the server holds the
   password in RAM to make SFTP connections. It is dropped when the connection
   cache (5 minutes) expires or when you log out.

The important distinction: *storing* (persisting to disk/DB) vs *keeping* (holding
in memory or in a client-side cookie). Filestash does not store; it keeps.

### 1.2 Technical detail

**Database.** The SQLite database (`state/db/`) holds shares, metadata, audit
entries and workflows. The only `password` fields persisted there are unrelated to
the pass-through flow:

- Share-link passwords are bcrypt-hashed and stored (`server/model/share.go:92-93`),
  and verified one-way via `bcrypt.CompareHashAndPassword`
  (`server/model/share.go:263-265`).
- Email SMTP credentials come from config, not the DB.

The SFTP backend password is never written to any table.

**Logs and identifiers.** Login/logout audit lines record only username, backend ID
and IP (`server/ctrl/session.go:507,544`, failure at 507: `[auth] status=failed
user=%s backend=%s::%s ip=%s err=%s`). `GenerateID` explicitly skips the keys
`password`, `path`, `session` and `timestamp` when computing backend identifiers
(`server/common/crypto.go:201-211`), so session IDs, share-ownership checks and
audit entries cannot leak the credential.

**Where the credential actually lives:**

| Location | Form | Lifetime |
| --- | --- | --- |
| `auth` cookie in the browser | `base64(zlib(AES-GCM(JSON(session map))))` — the full session map **including the plaintext password** | `general.cookie_timeout` (default `60*24*7` min = 1 week, `server/common/config.go:84`) |
| `ssoref` cookie (transient) | `label::state` only — no credentials | 10 minutes (`server/ctrl/session.go:356-368`) |
| Server memory — `ctx.Session` map | plaintext, decrypted per request | for the duration of the request |
| Server memory — `SftpCache` (LRU) | key = `hashstructure.Hash` of the **full params map, password included**; value = live `*Sftp` connection | 5 minutes (`server/common/cache.go:16-36`; cache created at `plg_backend_sftp/index.go:27`) |
| Server memory — `ssh.ClientConfig.Auth` | the password is retained inside the `ssh.Password(...)` / `KeyboardInteractive(...)` auth methods of the live SSH client | until the connection is closed/evicted |

**Optional extra copy.** If `general.extended_session` is enabled, the raw plugin
callback (i.e. `{"user": ..., "password": ...}` as JSON) is additionally embedded
under `session["session"]` (`server/ctrl/session.go:487-492`) and therefore also
enters the encrypted cookie. Default is `false` (`server/common/config.go:85`).

**Encryption in the cookie.** `EncryptString` = zlib-compress → AES-GCM →
base64url (`server/common/crypto.go:27-37, 128-144, 166-182`). The key is
`SECRET_KEY_DERIVATE_FOR_USER = Hash("USER_" + SECRET_KEY, len(SECRET_KEY))`
(`server/common/constants.go:76`). GCM gives confidentiality *and* integrity. Note
that the key lives on the same server that issues the cookie — this protects against
cookie theft, not against a compromised Filestash host.

### 1.3 Conclusion

Filestash never persists the password (no disk, no DB, no logs, no identifiers).
The credential's real residence is **the encrypted `auth` cookie in the browser and
transient server-side RAM**. "Encrypted" here is defense-in-depth, not a trust
boundary: anyone who can read the cookie *and* `general.secret_key` (or exploit the
server) can recover the password. The security of the stored credential is therefore
exactly the security of the Filestash deployment.

---

## 2. The route the password takes in the backend

### 2.1 Summary

You type your password into a web form. Filestash ships it to a login endpoint,
runs it through a small "template engine" that pastes it into the SFTP connection
settings, and then *dials the real SSH server with it* — that SSH login is the only
place your password is actually checked. After it succeeds, Filestash puts the
password (still in plain text, wrapped in encryption) into your browser cookie so it
doesn't have to ask again.

The journey in one line:

```
browser form → POST /api/session/auth/ → plugin.Callback → attribute-mapping
templates → Sftp.Init (ssh.Dial) → encrypted "auth" cookie
```

### 2.2 Technical detail

**Step A — Frontend entry.** When a connection uses the authentication middleware,
the connect page does not submit a normal form; it redirects the browser to
`api/session/auth/?action=redirect&label=<label>&state=<base64 URL params>`
(`public/assets/pages/connectpage/ctrl_form.js:171-182`). The route is registered at
`server/routes.go:32` with middlewares `[ApiHeaders, SecureHeaders, PluginInjector]`
— **no `RateLimiter`** (contrast the regular login `POST /api/session` at
`server/routes.go:26-27`).

**Step B — `SessionAuthMiddleware`** (`server/ctrl/session.go:279`):

- **Step 0** (lines 282-351): resolves the configured identity provider
  (`middleware.identity_provider.type` → `passthrough`, registered via
  `Hooks.Register.AuthenticationMiddleware("passthrough", ...)` at
  `server/plugin/plg_authenticate_passthrough/index.go:11-13`). Collects
  `formData` from the query string and, for POST, the parsed form body (lines
  304-326) — this is where `user` and `password` enter the backend as plain strings
  in a map. The IDP params are pre-evaluated once through `TmplExec`.
- **Step 1** (lines 353-376): on `GET ...&action=redirect`, calls
  `plugin.EntryPoint`, which renders the login page for the configured strategy
  (`direct` / `password_only` / `username_and_password`,
  `plg_authenticate_passthrough/index.go:56-89`). A `ssoref` cookie
  (`label::state`, 10 min TTL) is set so the follow-up POST can recover the label
  and state.
- **Step 2** (lines 378-458): `plugin.Callback` returns `{user, password}` **without
  any verification** (`plg_authenticate_passthrough/index.go:93-98`). The decoded
  base64 `state` JSON is merged into the template context unless the field already
  came from the callback (lines 453-458). Integrity of `state` fields is checked
  **only if** `features.protection.signature` lists them (AES-GCM signature check,
  lines 429-450); the default (empty) means no check.
- **Step 3** (lines 468-514): the **attribute mapping**
  (`middleware.attribute_mapping.params[label]` → map of field → Go text/template)
  is rendered with `TmplExec` for each field (lines 478-486) — this is where
  `{{ .user }}` / `{{ .password }}` inject the credential into, e.g.,
  `session["username"]` and `session["password"]`. If `general.extended_session`
  is on, the raw callback is additionally stored under `session["session"]`
  (lines 487-492). Then `model.NewBackend` (`server/model/files.go:9-51`) enforces
  the connection **allow-list** (`isAllowed`, lines 10-49: type/hostname/path/url
  must match a configured connection) and calls `Sftp.Init`.
- **Step 3.5 — `Sftp.Init`** (`server/plugin/plg_backend_sftp/index.go:44`):
  cache lookup keyed by the full params (line 62); if the `password` field parses
  as a PEM private key (`isPrivateKey`, lines 85-104) it is used as a key (optionally
  with `passphrase`), otherwise both `ssh.Password(p.password)` and
  `ssh.KeyboardInteractive` (which answers **every** prompt with the same password,
  lines 141-150) are registered. Host-key verification happens only if `hostkey`
  is configured; otherwise **any** host key is accepted (lines 156-170).
  `ssh.Dial` performs the real authentication: a wrong password yields
  `ErrAuthenticationFailed`, and the user is redirected to an error page whose URL
  reflects the backend error text (`server/ctrl/session.go:505-514`).
- **Step 4** (lines 516-545): the whole session map — **password included in
  plaintext inside** — is JSON-marshalled, compressed, AES-GCM encrypted with
  `SECRET_KEY_DERIVATE_FOR_USER` and set as the `auth` cookie
  (`COOKIE_NAME_AUTH`, `HttpOnly`, `SameSite=Strict`, MaxAge =
  `general.cookie_timeout` minutes). The `ssoref` cookie is cleared (lines 529-534).
  In iframe mode the same token is additionally returned in a `bearer` response
  header and appended to the redirect as a `#bearer=<token>` URL fragment (lines
  541-543).

**Step C — Every subsequent request.** `SessionStart`
(`server/middleware/session.go:57-83`) → `_extractAuthorization` (token from
`auth`/`auth1`/… cookies, or `Authorization: Bearer`, or `?authorization=` query
param, lines 160-185) → `_extractSession` (decrypt, unmarshal, timestamp check,
lines 259-312) → `_extractBackend` (`model.NewBackend` re-uses the cached SFTP
connection or dials again, lines 314-316). The password is thus re-decrypted from
the cookie on every request and re-presented to SSH on every cache miss.

### 2.3 Conclusion

The password travels as a **plain string** through the whole middleware pipeline
(form → map → template context → connection params → SSH auth methods) and is only
protected at the very end (cookie encryption) and at the very start (TLS, if
enabled). The only genuine verification point is the SSH handshake itself; the
`passthrough` plugin verifies nothing. Security properties (allow-list, no
logging, credential-excluding IDs) constrain what the credential can *do* and what
is *observable* about it, but the plaintext window in the backend is wide by
design.

---

## 3. How Filestash remembers the user's session

### 3.1 Summary

Filestash does **not** keep a list of logged-in users on the server. Instead it
gives your browser a sealed, encrypted "key card" (the `auth` cookie) that *is* the
session: it contains your connection details and password, encrypted with a key
only the server knows. On every request you send the card back; the server opens
it, checks it isn't ancient (max 1 year), and rebuilds your SFTP connection from
what's inside. When you log out, the card is shredded (the cookie is deleted).

Consequence: there is nothing for the server to forget or to revoke — if the cookie
still exists and is decryptable, you are still logged in.

### 3.2 Technical detail

**Session creation** (pass-through path): see §2.2 Step 4 — single `auth` cookie,
value = encrypted session JSON, path `/api/` (`COOKIE_PATH`,
`server/common/constants.go:16,45`), MaxAge = `general.cookie_timeout` minutes
(default 1 week, `server/common/config.go:84`). Cookie flags from
`applyCookieRules` (`server/ctrl/session.go:548-561`): `HttpOnly` always;
`SameSite=Strict` normally, but downgraded to `SameSite=None; Partitioned` with
`Secure` only when `features.protection.iframe` is set **and** the Referer is
`https://` — over plain HTTP the cookie is **not** `Secure`.

Note: unlike `SessionAuthenticate` (which splits the payload across `auth`,
`auth1`, … in 3800-byte chunks, `server/ctrl/session.go:161-183`), the middleware
path writes the entire token to one `auth` cookie (lines 535-540), so very large
sessions (long PEM keys, `extended_session`) risk the ~4 KB browser cookie limit.

**Per-request validation** (`server/middleware/session.go`):

1. `_extractAuthorization` (lines 160-185): token from split cookies → `Bearer`
   header → `?authorization=` query param (first non-empty wins).
2. `_extractSession` (lines 259-312): `DecryptString(SECRET_KEY_DERIVATE_FOR_USER,
   token)` → JSON unmarshal into the session map → parse `session["timestamp"]`
   (RFC3339, set at login at `server/ctrl/session.go:486`) → **reject if older than
   `24 * 365 * time.Hour`** (line 307). A decryption failure (e.g. after rotating
   `general.secret_key`) yields `ErrNotAuthorized`. For shared links the session is
   taken from the share record's encrypted `Auth` blob instead (lines 266-289).
3. `_extractBackend` (lines 314-316): `model.NewBackend(ctx, ctx.Session)` —
   re-creates the SFTP backend from the decrypted params (cache hit or fresh dial).

**Logout** (`server/ctrl/session.go:196-240`): clears all `auth*` cookies
(`CookieName(0..n)`, `server/common/utils.go:99-101`), the `admin` and `proof`
cookies, and (in a goroutine) closes the cached backend connection.

**Short-lived auxiliary state:** the `ssoref` cookie (`label::state`, 10 min,
`SameSite=Lax`-default) exists only between the redirect and the callback
(`server/ctrl/session.go:356-368`) and is deleted on success (lines 529-534).

**Expiration model (two independent clocks):**

| Clock | Value | Where |
| --- | --- | --- |
| Cookie `MaxAge` | `general.cookie_timeout` min (default 1 week) | `server/ctrl/session.go:538` |
| Session `timestamp` tolerance | 1 year | `server/middleware/session.go:307` |

Because the server-side check is 1 year, the effective lifetime is governed by the
cookie; a cookie replayed within that year (e.g. from a backup, a shared
`#bearer=` fragment, or a proxy cache) is fully valid.

### 3.3 Conclusion

Session "memory" is entirely client-side: an encrypted, self-contained credential
blob that the server decrypts and re-validates on every request. This makes the
system stateless and trivially horizontally scalable, but it means **the session is
the credential** — there is no separate short-lived session token, no server-side
revocation, and the one-year timestamp tolerance widens the replay window. Session
security reduces to: keep the cookie confidential (TLS, `HttpOnly`, `SameSite`,
`Secure`) and keep `general.secret_key` confidential (it also *is* the decryption
key, so rotating it is the only "kill switch").

---

## 4. Comparison with standard credential-storage practice

### 4.1 Summary

Standard web security says: check the password **once**, throw it away, and hand
the user a cheap, short-lived, revocable **token**. Filestash cannot do that here,
because the destination is an SSH server — SSH has no token concept, and the only
way to "stay logged in" is to keep the password (or key) and re-use it. So
Filestash's design *must* retain the credential; the question is only how well it
masks that fact. The encryption around the cookie, the clean logging and the
per-request SSH re-dial are good masking, but several of the surrounding safeguards
that are "default everywhere else" (TLS, host-key pinning, rate limiting, short
lifetimes) are opt-in or weak.

### 4.2 Side-by-side

| Concern | Standard practice | Filestash pass-through |
| --- | --- | --- |
| What's kept after login | A short-lived session token; the password is never retained | The raw credential itself, for the whole session lifetime (§1) |
| Credential at rest | One-way hash (bcrypt/argon2/scrypt) where retention is needed | Reversible by design — must be, to dial SSH again; encrypted (AES-GCM) in the cookie and held in RAM |
| Token exchange | Password → single-use ticket (OAuth token exchange, Kerberos TGT), then password discarded | No exchange — the same password re-authenticates on every SSH dial (§2.2 Step 3.5) |
| Session lifetime | Minutes–hours, refreshable, revocable server-side | 1-week cookie (configurable) **plus** a 1-year timestamp tolerance; no server-side revocation possible (stateless) (§3.2) |
| Transport | TLS mandatory | TLS optional; cookie `Secure` only in iframe+HTTPS mode; login form otherwise unprotected |
| Key separation | A stolen client artifact should not trivially yield the credential | The issuing server holds the decryption key — encryption is defense-in-depth, not a trust boundary |
| Rate limiting / lockout | Always on auth endpoints | Only on `POST /api/session`; **absent** on `/api/session/auth/` (`server/routes.go:26-32`) |
| Host key verification | Pinned (`known_hosts`) | Opt-in; default accepts any host key (`plg_backend_sftp/index.go:156-170`) |
| Session identifiers / logs | Never contain secrets | Correctly done: `GenerateID` excludes `password` etc. (`common/crypto.go:201-211`); audit lines are credential-free |
| Integrity of session data | Tokens are signed | AES-GCM provides authenticated encryption of the cookie; but `state` params are unsigned unless `features.protection.signature` is set |

**Where it falls below standard:**

1. The browser holds a **live credential for up to a week**; any token-theft
   vector (XSS, a shared `#bearer=` fragment, proxy caching) yields the password,
   not just a token.
2. The **1-year timestamp tolerance** is far looser than typical session/cookie
   lifetimes, widening the replay window.
3. **Host-key verification is opt-in**, so the password can be MITM'd on the wire
   to the SSH server (it is sent clear-text inside the SSH userauth exchange).
4. **No rate limiting** on the pass-through auth route; brute force is only
   throttled by SSH dial cost.
5. **TLS is not enforced by default** for either the form POST or the cookie.

**Where it meets or exceeds expectations:**

1. The credential is **re-verified against the real backend on every dial** — many
   real systems cache a session token and re-check nothing.
2. **No password in logs, IDs, or DB**; the cookie is properly protected
   (compress-then-encrypt, authenticated GCM, per-purpose derived keys,
   `HttpOnly`/`SameSite`).
3. The **connection allow-list** (`model/files.go:10-49`) stops the login form
   from being weaponised as an open SFTP/SSRF proxy.
4. `direct`/`password_only`/`username_and_password` strategies give operators a
   dial between "no credentials" and "full credentials" rather than a single mode.

### 4.3 Conclusion

Filestash's approach is **not a security violation; it is an architectural
necessity** — you cannot issue a "password-free token" to an SSH server that only
understands passwords and keys. Standard practice (verify-once, exchange-for-token,
short-lived, revocable) applies to identity providers, and Filestash's *own*
non-middleware path does exactly that (opaque encrypted session, 3800-byte cookie
splitting, OAuth token refresh in `SessionAuthenticate`). The pass-through path
deliberately trades that model for credential persistence, and compensates with
at-rest encryption, per-dial backend verification and credential-excluding
identifiers. The residual risk is therefore operational, and the recommended hardening is:

- Enforce TLS (`general.force_ssl`); prefer `password_only`/`username_and_password`
  over `direct`.
- Always configure a `hostkey` fingerprint per SFTP connection.
- Set `features.protection.signature` (e.g. `next,signature`) to sign `state` params.
- Add a `RateLimiter` to the `/api/session/auth/` chain.
- Reduce `general.cookie_timeout`; consider exchanging the password for a
  short-lived broker token after the first successful login (e.g. an SSH gateway
  that mints tickets), which would bring the design fully in line with the
  standard model.
- Rotate `general.secret_key` when staff/hosts change — it invalidates all
  existing session cookies and is the system's only global kill switch.

---

## 5. Cross-reference

Companion document with the broader security analysis (strategies, crypto
primitives, 15 identified weaknesses and recommendations):
[`filestash-passthrough-report.md`](filestash-passthrough-report.md).
