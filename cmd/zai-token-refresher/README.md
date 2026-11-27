# zai-token-refresher

Keeps the bridge's `ZAI_TOKEN_FILE` fresh.

A bare bearer token cannot be renewed upstream (see the root README section
"`ZAI_TOKEN` 过期了怎么办"), but the site's own web client rotates
`localStorage.token` while its login cookies are valid. This tool holds those
cookies in a persistent Chromium profile, reads the token the page already
refreshed, and writes it atomically to a file the bridge re-reads on startup
and on 401.

## Setup

```sh
cd cmd/zai-token-refresher
npm install
npx playwright install chromium     # skip if token-collector already did it
```

## Usage

```sh
npm start                           # loads the repo-root .env (incl. ZAI_BASE_URL)
node index.js                       # same, but without .env — defaults to chat.z.ai
node index.js --interval 900        # refresh every 15 minutes (default)
node index.js --headless            # already-authenticated profile only
node index.js --base-url https://zchat.z.ai   # mainland site
node index.js --out /path/to/token  # override the output path
```

**The token must be issued by the same site the bridge talks to.** If the
bridge's `ZAI_BASE_URL` is `https://zchat.z.ai`, either use `npm start` (which
reads the repo-root `.env`) or pass `--base-url https://zchat.z.ai` — a token
from `chat.z.ai` will be rejected by the mainland deployment.

The profile defaults to `.profile` next to this file, and the token to
`<repo>/runtime/zai-token` — the same path the bridge's `ZAI_TOKEN_FILE`
resolves to when started from the repo root.

Then point the bridge at the file:

```sh
# .env
ZAI_TOKEN_FILE=runtime/zai-token
```

The bridge prefers `ZAI_TOKEN_FILE` over `ZAI_TOKEN`, reloads it at startup and
after a 401, and retries once when the content actually changed.

## Notes

- The profile directory holds login cookies: keep it out of git (it already is).
- The output file is written with mode `0600`; it is a session credential.
- The browser is headful by default because the site's risk layer rejects
  headless clients. On a headless server use `xvfb-run -a node index.js`.
- Login sessions expire after days/weeks, not minutes. When that happens the
  tool logs that no token is available: run it without `--headless` and log in
  again. No token source can make renewal fully unattended.
- A stale or expired page token is never written, so the bridge keeps using
  the last good value until a fresh one appears.
