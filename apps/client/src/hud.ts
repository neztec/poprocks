import { CART_COST, SHIP_SPECS, totalResources, type CraftKind } from '@poprock/shared';
import { CrewPanel } from './crewpanel';
import type { Action } from './input';
import type { World } from './world';

const CRAFT_ACTIONS: Record<CraftKind, Action> = { scout: 'launchScout', driller: 'launchDriller', layer: 'launchLayer' };
const CRAFT_KEYS: Record<CraftKind, string> = { scout: '1', driller: '2', layer: '3' };

const HELP = `
<h3>Controls</h3>
<table>
<tr><td>Turn</td><td><kbd>A</kbd>/<kbd>D</kbd> rotate · or hold <kbd>LMB</kbd> toward the cursor · left stick points</td></tr>
<tr><td>Thrust / brake</td><td><kbd>W</kbd> thrust along the nose · <kbd>S</kbd> brake</td></tr>
<tr><td>Boost</td><td><kbd>Shift</kbd> · <kbd>LT</kbd></td></tr>
<tr><td>Drill / lay rail</td><td><kbd>Space</kbd> · <kbd>RMB</kbd> · <kbd>RT</kbd></td></tr>
<tr><td>Board a craft</td><td>Drag your face onto a craft (panel or world) · <kbd>1</kbd> Scout · <kbd>2</kbd> Driller · <kbd>3</kbd> Rail layer · pad <kbd>Y</kbd> pick, <kbd>B</kbd> board</td></tr>
<tr><td>Dock</td><td>Fly back into your formation slot · <kbd>E</kbd> · <kbd>B</kbd> (near the mothership)</td></tr>
<tr><td>Drop cargo on rail</td><td><kbd>Q</kbd> · <kbd>X</kbd></td></tr>
<tr><td>Fly the mothership</td><td>Drag your face to <b>HELM</b> · <kbd>H</kbd> · <kbd>Start</kbd> — slow in a system, fast in hyperspace</td></tr>
<tr><td>Jump to hyperspace</td><td><kbd>J</kbd> · <kbd>Back</kbd> (pilot, in a system)</td></tr>
<tr><td>Pick a star</td><td>Click it · <kbd>Tab</kbd> · d-pad ◀ ▶</td></tr>
<tr><td>Autopilot to it</td><td><kbd>Enter</kbd> · <kbd>A</kbd> — steering takes back control</td></tr>
<tr><td>Build rail cart</td><td><kbd>C</kbd> (${CART_COST.ferrite} ferrite)</td></tr>
<tr><td>Zoom</td><td>Wheel · <kbd>+</kbd>/<kbd>-</kbd> · <kbd>LB</kbd>/<kbd>RB</kbd></td></tr>
</table>
<p class="dim">Loop: drill ore with a Driller → lay rail from the tunnels back to the mothership's green depot ring →
drop cargo on the rail → carts haul it home. Or just dock with a full hold.</p>`;

export class Hud {
  private status: HTMLElement;
  private crew: HTMLElement;
  readonly crewPanel: CrewPanel;
  private context: HTMLElement;
  private toasts: HTMLElement;
  private help: HTMLElement;
  private conn: HTMLElement;
  private last = { status: '', crew: '', context: '' };
  onAction: (a: Action) => void = () => {};

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div id="status" class="panel"></div>
      <div id="crew" class="panel"></div>
      <div id="context" class="panel"></div>
      <div id="toasts"></div>
      <div id="help" class="panel">${HELP}</div>
      <div id="conn" class="panel">Connection lost — reconnecting…</div>`;
    this.status = root.querySelector('#status')!;
    this.crew = root.querySelector('#crew')!;
    this.crewPanel = new CrewPanel(this.crew);
    this.context = root.querySelector('#context')!;
    this.toasts = root.querySelector('#toasts')!;
    this.help = root.querySelector('#help')!;
    this.conn = root.querySelector('#conn')!;
    this.context.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.action as Action | undefined;
      if (a) this.onAction(a);
    });
  }

  toggleHelp(): void {
    this.help.classList.toggle('open');
  }

  setConnected(ok: boolean): void {
    this.conn.style.display = ok ? 'none' : 'block';
  }

  toast(text: string): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 5) this.toasts.firstChild?.remove();
    setTimeout(() => (el.style.opacity = '0'), 5000);
    setTimeout(() => el.remove(), 5700);
  }

  update(world: World, selectedCraft: CraftKind, selectedTarget: number | null, gamepad: boolean): void {
    const crew = world.crew;
    if (!crew) return;
    const ship = world.you?.ship ?? null;
    const myCraft = ship && ship.kind !== 'mothership' ? ship.kind : null;
    const isPilot = crew.pilotId === world.playerId;

    this.set(
      'status',
      `<h3>${crew.name}</h3>
       <div class="loc">${esc(crew.location)}</div>
       <div><span class="ferrite">■ ${crew.resources.ferrite} ferrite</span> &nbsp; <span class="auric">■ ${crew.resources.auric} auric</span></div>
       <div class="dim"><kbd>?</kbd> controls</div>`,
    );

    this.crewPanel.update(crew, world.playerId);

    let ctx = '';
    if (myCraft) {
      const spec = SHIP_SPECS[myCraft];
      ctx += `<div><b>${spec.label}</b> · ${hintFor(myCraft, gamepad)}</div>`;
      if (myCraft === 'layer' && crew.cartStatus && !crew.cartStatus.depotLinked) {
        ctx += `<div class="warn">Run the track into the mothership's green depot ring so carts can deploy.</div>`;
      }
      const cargo = world.you?.cargo;
      if (cargo && spec.hold > 0) {
        const n = totalResources(cargo);
        ctx += `<div class="dim">Hold ${n}/${spec.hold} — <span class="ferrite">${cargo.ferrite}</span> / <span class="auric">${cargo.auric}</span></div>
                <div class="bar"><div style="width:${Math.round((n / spec.hold) * 100)}%"></div></div>`;
      }
      ctx += `<div class="row"><button data-action="dock">Dock <kbd>${gamepad ? 'B' : 'E'}</kbd></button>${
        myCraft === 'driller' ? `<button data-action="drop">Drop cargo on rail <kbd>${gamepad ? 'X' : 'Q'}</kbd></button>` : ''
      }</div>`;
    } else if (crew.inSystem) {
      ctx += isPilot
        ? `<div>At the helm — <kbd>A</kbd>/<kbd>D</kbd> turn, <kbd>W</kbd> thrust, <kbd>S</kbd> brake. The mothership is slow here.</div><div class="row">`
        : `<div>In crew quarters — drag your face onto a craft to board it, or onto the helm.</div><div class="row">`;
      for (const k of Object.keys(CRAFT_ACTIONS) as CraftKind[]) {
        const free = crew.fleet.filter((f) => f.kind === k && f.pilotId == null).length;
        ctx += `<button data-action="${CRAFT_ACTIONS[k]}" class="${k === selectedCraft ? 'selected' : ''}" ${free ? '' : 'disabled'}>${
          SHIP_SPECS[k].label
        } ×${free} <kbd>${CRAFT_KEYS[k]}</kbd></button>`;
      }
      ctx += `<button data-action="buildCart" ${crew.resources.ferrite < CART_COST.ferrite ? 'disabled' : ''}>Build cart (${CART_COST.ferrite} ferrite) <kbd>C</kbd></button>`;
      ctx += `</div><div class="row">${helmButton(isPilot, crew.pilotId != null, gamepad)}`;
      if (isPilot) ctx += `<button data-action="jump">Jump to hyperspace <kbd>${gamepad ? 'Back' : 'J'}</kbd></button>`;
      ctx += `</div>`;
    } else {
      const target = world.systems.find((s) => s.id === (crew.autopilotTarget ?? selectedTarget));
      if (isPilot) {
        if (crew.autopilotTarget != null && target) {
          const eta = world.you?.eta;
          ctx += `<div>Autopilot → <b>${esc(target.name)}</b>${eta != null ? ` · ETA ${Math.ceil(eta)}s` : ''} <span class="dim">(steer to take over)</span></div>`;
        } else if (target) {
          ctx += `<div>Selected <b>${esc(target.name)}</b> — <kbd>${gamepad ? 'A' : 'Enter'}</kbd> to engage autopilot</div>`;
        } else {
          ctx += `<div>Hyperspace — fly into a star to enter its system, or click one to autopilot.</div>`;
        }
      } else {
        const pilot = crew.members.find((m) => m.id === crew.pilotId);
        ctx += `<div>${pilot ? `${esc(pilot.name)} is flying the mothership.` : 'Nobody is at the helm.'}</div>`;
      }
      ctx += `<div class="row">${helmButton(isPilot, crew.pilotId != null, gamepad)}</div>`;
    }
    this.set('context', ctx);
  }

  private set(which: 'status' | 'crew' | 'context', html: string): void {
    if (this.last[which] === html) return;
    this.last[which] = html;
    this[which].innerHTML = html;
  }
}

function helmButton(isPilot: boolean, taken: boolean, gamepad: boolean): string {
  const key = `<kbd>${gamepad ? 'Start' : 'H'}</kbd>`;
  if (isPilot) return `<button data-action="helm">Leave helm ${key}</button>`;
  return `<button data-action="helm" ${taken ? 'disabled' : ''}>Take helm ${key}</button>`;
}

function hintFor(kind: CraftKind, pad: boolean): string {
  const act = pad ? 'RT' : 'Space/RMB';
  switch (kind) {
    case 'scout':
      return 'fast glider, feels gravity — release the stick to coast';
    case 'driller':
      return `hold <kbd>${act}</kbd> to drill; ore fills the hold`;
    case 'layer':
      return `hold <kbd>${act}</kbd> to lay rail along open tunnels`;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
