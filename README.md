# 🧹 HexRace — Broomstick Alchemy Racing

A 3D online multiplayer party game: race broomsticks through floating magical tracks,
then out-brew your rivals between rounds. Best total score after **3 rounds** wins.

Built with **Three.js** (client) and **Node.js + Socket.io** (listen server).

## How multiplayer works (Listen Server)

One player **hosts**: their machine runs the game server. Friends on the same network
(or via a forwarded port / tunnel) open the host's URL in a browser and join the lobby.
There is no dedicated server — the host *is* the server.

The server is authoritative: it simulates all broom physics, projectiles, pickups and
phase logic at 30 Hz and broadcasts snapshots at 20 Hz. Clients predict their own broom
locally (shared physics module) and smoothly reconcile, while remote players are
interpolated ~100 ms in the past.

## Quick start

```bash
npm install

# Development (server :3001 + Vite client :5173, proxied websocket)
npm run dev

# Production (single port — this is what you host for friends)
npm run build
npm start            # serves the built client + websocket on http://<your-LAN-ip>:3001
```

The lobby screen shows a **shareable join URL** (the server reports its LAN IPs at `/info`).

## Game loop

```
LOBBY → [ RACE → RESULTS → PANTRY → CAULDRON → DEPLOYMENT ] ×3 → PODIUM
```

### Phase 1 — The Race
- Full 3D broomstick flight: pitch/turn with momentum, drag and banking.
- **Action items** (instant use, key `Space`): Magic Wand (homing bolt), Shield, Invisibility.
- **Essences** scattered on the track — grab them, they fuel your alchemy later.
- **Knockout**: a wand hit or crashing into rocks/ground knocks you off the broom.
  The broom returns after a moment; you respawn at the last gate with **3 s ghost
  immunity** and a short speed boost.
- Finishing order awards points (10 / 8 / 6 / 5 / 4 / 3 / 2 / 1).

### Phase 2 — The Pantry
- A shared, limited pantry stock. Drafting is turn-based **from last place to first**.
- **Rubberband inventory**: 1st place gets **3 slots**, last place gets **7**.
- Rarities cost slots: Common = 1, Rare = 2, Legendary = 3.

### Phase 3 — The Cauldron
- Combine pantry ingredients + race essences into potions (recipe book in-game).
- **Permanent buffs/nerfs** persist across rounds (max **1 buff + 1 nerf** active per player).
- **Antidotes** cleanse a nerf — or grant immunity at the next race start if you're clean.
- **One-time usables** (key `E` in the race): Surge, Veil, Hexbolt.

### Deployment
Before the next race everyone secretly targets their permanent potions; all effects are
revealed and applied **simultaneously**. If a target's nerf slot is full, a stronger-tier
potion overwrites the old nerf; an equal/weaker one fizzles.

## Controls

| Key | Action |
| --- | --- |
| `W / S` | Pitch down / up (dive / climb) |
| `A / D` | Turn left / right |
| `Shift` | Boost (drains charge) |
| `Space` | Use held action item |
| `E` | Drink brewed usable potion |

## Repo layout

```
shared/   — deterministic game data + broom physics, used by BOTH client & server
server/   — Express + Socket.io listen server, Room state machine, 30 Hz race sim
client/   — Vite + Three.js; all 3D assets & VFX are procedural (no binary assets)
```

## Tests

`npm test` boots a real server with `HEXRACE_FAST=1` (shrunken timers), connects three
real Socket.io clients and plays a complete 3-round match end-to-end.
