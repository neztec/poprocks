# Poprock

Multiplayer space prototype: one persistent home galaxy on a server, a shared crew mothership, and small craft
that fly, drill, and lay rails inside giant asteroids. See [DESIGN.md](DESIGN.md) for direction and decisions.

## Layout

```
packages/shared   game rules shared by server + client: terrain, flight models, rails, protocol
apps/server       Node game server: 30Hz authoritative sim, WebSockets (/ws), admin REST (/api), SQLite
apps/client       Vite + PixiJS web client with own-ship prediction
apps/admin        Vite + React admin site: live overview, systems/asteroids editor, events
```

## Run

Needs Node **22.13+** (24 recommended) inside WSL/Linux — the built-in `node:sqlite` is used, so there are no native
modules to compile.

```bash
npm install
npm run dev          # server :8080, client :5173, admin :5174
```

- Game: http://localhost:5173 — open two tabs (or two machines; use `?server=host:8080` for a remote server)
- Admin: http://localhost:5174
- State lives in `apps/server/poprock.db` (delete it to reset the galaxy). Saved every 10s and on Ctrl-C.

```bash
npm test             # shared rules tests (determinism, terrain, collision, rails)
npm run typecheck
```

## Playing

Press `?` in game for the full control list. Mouse, keyboard and a standard gamepad all work.

1. You start aboard the crew mothership, parked in **Vesta (Home)**.
2. Launch a **Driller** (`2`). Hold left mouse toward where you want to go, hold `Space`/right mouse to drill into
   *Vesta Major* to the west. Orange **ferrite** and gold **auric** fill your hold.
3. Dock (`E`) inside the blue ring to deliver ore, **or** build the rail loop:
   launch a **Rail Layer** (`3`), hold `Space` to lay track from your tunnels back into the mothership's green
   depot ring, then in the Driller press `Q` next to the rail to drop cargo. A cart hauls it home.
4. Spend 40 ferrite on another cart (`C`).
5. Take the helm (`H`), jump (`J`), and in hyperspace click a star to autopilot there. Steering takes over manually;
   flying into a star drops you into its system.

Scouts are fast gliders that feel the star's gravity — let go of the stick to coast and slingshot.

## Admin

- **Overview**: players, crew resources, per-system counts; broadcast a message.
- **Systems**: edit name/galaxy position/color/parking spot/wildlife target and gravity bodies; click the map to place
  new asteroids; regenerate or delete asteroids (wipes their tunnels); clear rails.
- **Events**: scheduled scenario beats — `broadcast`, `spawnCritters`, `oreBloom`, `grantResources` — with delay /
  repeat, enable toggle, and *Fire now*.

The admin API has no auth yet — keep the server on a trusted network.
