# Poprock — Design Notes

Multiplayer space prototype. One persistent home galaxy hosted by a server; web clients connect, fly a
mothership across a galaxy map, park it in a system, and launch smaller craft to fly, drill, and lay
rails inside giant asteroids.

Parts harvested (rewritten, not copied) from `~/Git/Antopolous`.

## Decisions (2026-11-12)

| Topic | Decision |
|---|---|
| Multiplayer | Start with one shared-crew mothership; server designed for many crews in the same galaxy later. |
| Rails | Laid on purpose by a rail-layer craft/tool along drilled tunnels. Other craft (carts, haulers, automated miners) lock onto and ride them. Rails are the backbone of resource logistics. |
| Persistence | Permanent and shared. Tunnels, rails, and asteroid state survive server restarts. |
| Small-craft flight | Varies by craft: light scouts use Antopolous-style steady-speed steering; heavy drills/haulers use thrust + inertia; rail riders follow the track. |
| Galaxy map | Real-time mothership flight (SC2 hyperspace). Choose a target → autopilot with an arrival estimate; any manual thrust cancels autopilot. Entering a system drops into that system's local map. |
| Milestone 1 | A rough version of every system (see below). |
| Rendering | PixiJS (WebGL). |
| Stack | TypeScript everywhere, Node server, WebSockets, SQLite, React admin site. |
| Input | Mouse/keyboard and gamepad from day one. |
| Dropped from Antopolous | Crystals/fuel, formation mods, queen/eggs/colonies, rainbow gem, collectibles. |

## Harvest map (Antopolous → Poprock)

| Antopolous | Becomes |
|---|---|
| `SquarePlanet` grid, carve, collision, layers, tunnel generator | `shared/terrain`: `Uint8Array` material ids per cell, seed-generated base shape, carve operations as the unit of change |
| Drill head stepping between frames (`main.js` ~770) | Drill tool on driller craft; server-authoritative carve events |
| `drillNodes` tunnel graph | Basis for navigation for wildlife/rail pathing; rails are a separate player-built graph on top |
| Steady-speed steering + gravity + slingshot | `shared/flight` "glide" model for scouts |
| `InputManager` (gamepad + drag joystick) | `client/input` normalized into an `InputState` sent to the server |
| `GhostOrb` / `NPCShip` graph-following AI | Starting point for wildlife behavior |

## Architecture

```
poprock/
  packages/shared   sim: flight models, terrain, carve, rails, entities, protocol types, fixed timestep
  apps/server       Node + ws. Authoritative sim per "space" (galaxy map, each system). SQLite persistence.
  apps/client       Vite + PixiJS. Prediction for own craft, interpolation for others. Chunked terrain textures.
  apps/admin        Vite + React. Edit systems, asteroids, missions/events/scenarios; live server view.
```

- **Spaces:** the galaxy map and each star system are separate simulation spaces on the server. Each player
  entity lives in exactly one space; only that space's state is streamed to them.
- **Netcode:** fixed tick (e.g. 30Hz sim, ~15Hz snapshots). Clients send input; server is authoritative.
  The client predicts its own ship and reconciles against the server.
- **Terrain sync:** asteroid = seed + ordered log of carve operations (compacted periodically into a
  stored cell snapshot). Clients rebuild from seed/snapshot and apply carve events live.
- **Rendering terrain:** split into chunks (e.g. 64×64 cells) cached as textures; only chunks that changed get redrawn.

## Milestone 1 — a rough version of every system

1. **Server + 2 clients**: connect with just a display name (no real login yet), see each other in real time.
2. **Galaxy map**: a handful of star systems; mothership real-time flight, target-and-autopilot, manual thrust cancels.
3. **System view**: entering a system parks the mothership; one or two giant drillable asteroids.
4. **Craft**: launch from / dock to mothership. Two types: Scout (glide model) and Driller (thrust model + drill).
5. **Drilling**: persistent, shared, synced carving. Materials include at least one resource ore.
6. **Rails**: Driller (or a third Rail-layer craft) lays rail along a tunnel; a simple automated cart rides it.
7. **Wildlife**: one creature type that wanders tunnels/open space (behavior TBD).
8. **Admin site**: list/edit star systems and asteroid seeds; create a simple timed event; live entity view.
9. **Input**: mouse/keyboard + gamepad for all of the above.

## Open questions

- Wildlife role: ambient, hostile, harvestable, or part of the economy loop?
- Economy loop shape: ore → rail cart → mothership → ? (upgrades, new craft, trading between crews)
- Mothership control with a crew: who flies it? (first in seat / captain role / anyone)
- What a "mission/event/scenario" contains for the admin site (triggers, spawns, objectives, rewards).
