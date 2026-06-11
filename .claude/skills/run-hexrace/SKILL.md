---
name: run-hexrace
description: Run, drive, screenshot or smoke-test the HexRace game (3D multiplayer broom racing). Boots the listen server, plays a full match in headless Chromium via the driver, captures per-phase screenshots. Use for "run the game", "verify the game works", "screenshot HexRace", "play a match".
---

# Run HexRace

HexRace is a browser game (Three.js client + Socket.io listen server, one
port in production). All paths below are relative to the repo root. Node is
NOT on PATH on this machine — every shell needs:

```bash
export PATH="$HOME/.local/node/bin:$PATH"
```

## Prerequisites

```bash
npm install                  # workspace deps (server + client)
npm run build                # client bundle -> client/dist (server serves it)
# Playwright for the driver (kept OUT of the repo, scratch dir is fine):
mkdir -p /tmp/hexrace-verify && cd /tmp/hexrace-verify \
  && npm init -y && npm install playwright && npx playwright install chromium
```

The driver resolves `playwright` from the repo root, `/tmp/hexrace-verify`,
or the cwd — the scratch install above is enough.

## Run (agent path) — the driver

Plays a complete match through the real UI (join → ready → race with held
keys → pantry clicks → cauldron → podium), screenshots every phase, exits
non-zero on any page error or if the podium is never reached:

```bash
node .claude/skills/run-hexrace/driver.mjs --players 3 --fast 8 --out /tmp/hexrace-shots
```

- `--players N` 1–8 browser pages (1 = solo practice mode)
- `--fast D` HEXRACE_FAST divisor: 8 ≈ 2-minute match, good for screenshots;
  1/blank = real-time (a race alone can run 4 min — don't, unless testing pacing)
- `--port` (default 3217), `--timeout` seconds (default 180)
- Screenshots land in `--out` as `r<round>-<phase>.png` + `lobby.png`,
  `podium.png`. **Look at them** — `r1-race.png` must show the HUD, a witch
  on a broom, gate rings and the minimap.

The driver boots its own server; don't pre-start one on the same port.

In-page hook for custom Playwright scripts: `window.__hexrace =
{ phase, round, myId, players }` (set on every room push after joining).

## Run (human path)

```bash
npm run dev          # server :3001 + Vite HMR client :5173 (open this one)
# or production:
npm run build && npm start    # everything on http://<LAN-ip>:3001
```

Lobby shows the shareable LAN join URL (served from `/info`).

## Test

```bash
npm test    # server/test/e2e.js — 3 real socket clients, full 3-round match,
            # HEXRACE_FAST=1 (×40). ~15 s. Exits non-zero on failure.
```

## Gotchas

- `node`/`npm` not found → the local Node lives at `~/.local/node/bin`
  (v22.12.0). Export PATH first; `/bin/sh` scripts don't inherit it.
- Playwright browsers download to the **flatpak VS Code cache**
  (`~/.var/app/com.visualstudio.code/cache/ms-playwright`) on this machine
  because of XDG_CACHE_HOME — harmless, just don't look for them in
  `~/.cache`.
- `npm start` without `npm run build` serves a plain-text hint page, not the
  game — the driver will fail on the missing name input.
- Fast-mode countdown (`--fast 40`) is 75 ms; phase screenshots can miss it.
  `--fast 8` reliably captures every phase.
- Joining is only possible in the LOBBY phase ("Match in progress" otherwise),
  so the driver must connect all pages before clicking Start.
- Headless Chromium has no color-emoji font: medals/item icons render as
  pale monochrome glyphs in screenshots. Real browsers are fine.

## Troubleshooting

- `playwright not found` from the driver → run the scratch install from
  Prerequisites (the repo intentionally doesn't depend on playwright).
- Driver exits with `match did not reach the podium` and the log shows the
  same phase repeating → a player page crashed; check the printed
  `pageerror` lines, they carry the client stack trace.
- `EADDRINUSE` on 3217 → a previous driver run left a server: `pkill -f
  "node server/index.js"`.
