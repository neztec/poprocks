import { CART_COST, SHIP_SPECS, type CrewMember, type CrewWire, type FleetCraftWire } from '@poprock/shared';

/** Where a dragged crew face can land. */
export type SeatTarget = { kind: 'helm' } | { kind: 'quarters' } | { kind: 'craft'; id: number };

const DIAGRAM = 280;
const RING = 112;

/**
 * The mothership's crew diagram: helm seat and crew quarters inside the hull, fleet craft in their
 * formation slots around it. Drag your own face to a seat or craft (or onto a craft in the world).
 */
export class CrewPanel {
  /** Resolve a drop that landed on the game canvas (a craft or the mothership in the world). */
  worldTargetAt: (x: number, y: number) => SeatTarget | null = () => null;
  /** Called while dragging over the world so the scene can highlight a craft. */
  onWorldHover: (t: SeatTarget | null) => void = () => {};
  onSeat: (t: SeatTarget) => void = () => {};

  private last = '';
  private ghost: HTMLElement | null = null;
  private press: { x: number; y: number; dragging: boolean; from: string | null; draggable: boolean } | null = null;
  private hoverEl: HTMLElement | null = null;

  constructor(private root: HTMLElement) {
    root.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', () => this.cancel());
  }

  update(crew: CrewWire, me: number): void {
    const html = render(crew, me);
    if (html === this.last) return;
    this.last = html;
    this.root.innerHTML = html;
  }

  // ---- drag and drop ----

  private down(e: PointerEvent): void {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    const drag = el.closest<HTMLElement>('[data-drag]');
    const drop = el.closest<HTMLElement>('[data-drop]');
    if (!drag && !drop) return;
    e.preventDefault();
    this.press = { x: e.clientX, y: e.clientY, dragging: false, from: drop?.dataset.drop ?? null, draggable: !!drag };
  }

  private move(e: PointerEvent): void {
    const p = this.press;
    if (!p || !p.draggable) return;
    if (!p.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) {
      p.dragging = true;
      const face = this.root.querySelector<HTMLElement>('[data-drag]');
      this.ghost = (face?.cloneNode(true) as HTMLElement) ?? document.createElement('div');
      this.ghost.classList.add('drag-ghost');
      document.body.appendChild(this.ghost);
      document.body.classList.add('dragging-crew');
    }
    if (!p.dragging || !this.ghost) return;
    this.ghost.style.left = `${e.clientX}px`;
    this.ghost.style.top = `${e.clientY}px`;
    const { el, world } = this.targetAt(e.clientX, e.clientY);
    if (el !== this.hoverEl) {
      this.hoverEl?.classList.remove('drop-hover');
      el?.classList.add('drop-hover');
      this.hoverEl = el;
    }
    this.onWorldHover(world);
  }

  private up(e: PointerEvent): void {
    const p = this.press;
    if (!p) return;
    const { el, world, target } = this.targetAt(e.clientX, e.clientY);
    // A drag lands wherever it's released; a plain click acts on the slot it started on.
    if (p.dragging) {
      if (target) this.onSeat(target);
    } else if (el && el.dataset.drop === p.from && target && !world) {
      this.onSeat(target);
    }
    this.cancel();
  }

  private cancel(): void {
    this.press = null;
    this.ghost?.remove();
    this.ghost = null;
    this.hoverEl?.classList.remove('drop-hover');
    this.hoverEl = null;
    document.body.classList.remove('dragging-crew');
    this.onWorldHover(null);
  }

  private targetAt(x: number, y: number): { el: HTMLElement | null; world: SeatTarget | null; target: SeatTarget | null } {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const el = hit?.closest<HTMLElement>('[data-drop]') ?? null;
    if (el) return { el, world: null, target: parseDrop(el.dataset.drop!) };
    if (hit?.tagName === 'CANVAS') {
      const world = this.worldTargetAt(x, y);
      return { el: null, world, target: world };
    }
    return { el: null, world: null, target: null };
  }
}

function parseDrop(v: string): SeatTarget | null {
  if (v === 'helm' || v === 'quarters') return { kind: v };
  if (v.startsWith('craft:')) return { kind: 'craft', id: Number(v.slice(6)) };
  return null;
}

// ---- rendering ----

function render(crew: CrewWire, me: number): string {
  const byId = new Map(crew.members.filter((m) => m.id != null).map((m) => [m.id!, m]));
  const pilot = crew.pilotId != null ? byId.get(crew.pilotId) : undefined;
  const aboard = crew.members.filter((m) => m.online && m.craftId == null && m.id !== crew.pilotId);
  const offline = crew.members.filter((m) => !m.online);
  const c = DIAGRAM / 2;

  const slots = crew.fleet
    .map((f) => {
      // Diagram forward is up; formation slots go clockwise from the nose like in the world.
      const a = -Math.PI / 2 + ((f.slot + 0.5) / crew.fleet.length) * Math.PI * 2;
      const x = c + Math.cos(a) * RING;
      const y = c + Math.sin(a) * RING;
      const who = f.pilotId != null ? byId.get(f.pilotId) : undefined;
      return craftSlot(f, who, me, x, y, crew.inSystem);
    })
    .join('');

  const empty = aboard.length === 0 && offline.length === 0;
  return `<h3>Mothership · drag your face to a seat</h3>
    <div class="ms-diagram" style="width:${DIAGRAM}px;height:${DIAGRAM}px">
      <div class="ms-ring" style="width:${RING * 2}px;height:${RING * 2}px"></div>
      <div class="ms-hull">
        <div class="ms-seat helm" data-drop="helm" title="Helm: fly the mothership">
          ${pilot ? face(pilot, me) : '<span class="seat-label">HELM</span>'}
        </div>
        <div class="ms-quarters" data-drop="quarters" title="Crew quarters">
          <span class="seat-label">QUARTERS</span>
          <div class="faces">${aboard.map((m) => face(m, me)).join('')}${offline.map((m) => face(m, me)).join('')}${
            empty ? '<span class="dim">empty</span>' : ''
          }</div>
        </div>
      </div>
      ${slots}
    </div>
    ${cartRow(crew)}`;
}

/** Cart counts plus the one thing blocking them, if anything. */
function cartRow(crew: CrewWire): string {
  const st = crew.cartStatus;
  if (crew.carts === 0) {
    return `<div class="carts"><b>Rail carts:</b> none <span class="dim">— build one for ${CART_COST.ferrite} ferrite (<kbd>C</kbd>)</span></div>`;
  }
  if (!st) return `<div class="carts"><b>Rail carts:</b> ${crew.carts} stowed for the jump</div>`;
  const parts = [`${st.aboard} aboard`, `${st.waiting} waiting on rail`, `${st.hauling} hauling`];
  let hint = '';
  if (!st.depotLinked) {
    hint = `<div class="cart-hint warn">Carts deploy when rail reaches the <span class="depot">green depot ring</span>. Lay track into it with the Rail Layer (<kbd>3</kbd>).</div>`;
  } else if (st.unreachablePiles > 0) {
    hint = `<div class="cart-hint warn">${st.unreachablePiles} cargo pile${st.unreachablePiles === 1 ? ' is' : 's are'} on track that doesn't connect to the depot.</div>`;
  } else if (st.cargoPiles === 0 && st.hauling === 0) {
    hint = `<div class="cart-hint dim">Drop ore on any connected rail with a Driller (<kbd>Q</kbd>) and a cart will fetch it.</div>`;
  }
  return `<div class="carts"><b>Rail carts:</b> ${parts.join(' · ')}</div>${hint}`;
}

function craftSlot(f: FleetCraftWire, who: CrewMember | undefined, me: number, x: number, y: number, inSystem: boolean): string {
  const spec = SHIP_SPECS[f.kind];
  const cls = ['ms-craft', `k-${f.kind}`, f.out ? 'out' : '', !inSystem ? 'stowed' : ''].join(' ');
  return `<div class="${cls}" data-drop="craft:${f.id}" style="left:${x}px;top:${y}px" title="${spec.label}${
    f.out ? ' (out of formation)' : ''
  }">
      <span class="craft-glyph">${spec.label[0]}</span>
      ${who ? face(who, me) : ''}
      <span class="craft-name">${spec.label}</span>
    </div>`;
}

function face(m: CrewMember, me: number): string {
  const mine = m.id === me;
  const hue = hashHue(m.name);
  const cls = ['face', mine ? 'me' : '', m.online ? '' : 'offline'].join(' ');
  return `<span class="${cls}" ${mine ? 'data-drag="me"' : ''} style="--hue:${hue}" title="${esc(m.name)}${
    m.online ? '' : ' (offline)'
  }">${esc(initials(m.name))}</span>`;
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
}
