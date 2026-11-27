# token-collector (Node.js port)

Node.js port of `cmd/token-collector` after the Fielin rewrite. The browser is
used **exactly once, headful**, to register a trusted device session with
Aliyun-SAF and capture one genuine device token; every remaining token is then
minted in-process (`feilin.js`) with AES-128-CBC + an MD5 seal. Tokens land in
`tokens.sqlite` (in the current working directory) for the main service.

## Requirements

- Node.js >= 22 (uses the built-in `node:sqlite` module; tested on v24)
- Playwright Chromium browser binaries
- A **display** — the browser must run headful (headless device sessions are
  rejected by the Aliyun risk layer and the tokens will not verify). On a
  headless server use Xvfb, e.g. `xvfb-run -a node index.js`.

## Setup

```sh
cd node/cmd/token-collector
npm install
npx playwright install chromium
```

## Usage

```sh
node index.js                                  # interactive prompt
node index.js --tokens 850                     # mint N tokens (max 1500)
node index.js --session-max-age 15m            # re-harvest after 15 minutes
node index.js --export-session session.json    # dump session + payload template
node index.js --help
```

`--headed` is accepted for compatibility but is a no-op: the browser always
runs headful. `--no-tui` is accepted for compatibility (this port has no TUI).

## Database

Writes `tokens.sqlite` in the directory where the command is run, with the
schema the bridge reads:

```sql
CREATE TABLE IF NOT EXISTS tokens (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT    NOT NULL
);
```

The database file (and its `-wal`/`-shm` sidecars) is deleted at startup —
each run starts fresh. The bridge consumes rows FIFO and deletes them after use.

## How it works

1. **Harvest** (`harvest.js`) — one headful visit to `https://chat.z.ai`; the
   injected script boots the Aliyun captcha SDK, which registers the device
   (Log1 → InitCaptchaV3 → Log2 → Log3). It captures the `DeviceConfig` from
   the device service's Log1 response and one genuine token.
2. **Mint** (`feilin.js`) — pure computation: refresh the per-session /
   per-token payload fields, AES-128-CBC encrypt with the session key, seal
   with MD5, base64-assemble. No further browser traffic.

Golden-vector tests (`tests/feilin.test.js`) pin the implementation to the
captured live traffic byte-for-byte.
