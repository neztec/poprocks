import type { InputState } from '@poprock/shared';

export type Action =
  | 'launchScout'
  | 'launchDriller'
  | 'launchLayer'
  | 'dock'
  | 'dockOrLaunch'
  | 'cycleCraft'
  | 'helm'
  | 'jump'
  | 'drop'
  | 'buildCart'
  | 'targetNext'
  | 'targetPrev'
  | 'engage'
  | 'zoomIn'
  | 'zoomOut'
  | 'help';

const KEY_ACTIONS: Record<string, Action> = {
  '1': 'launchScout',
  '2': 'launchDriller',
  '3': 'launchLayer',
  e: 'dockOrLaunch',
  h: 'helm',
  j: 'jump',
  q: 'drop',
  c: 'buildCart',
  tab: 'targetNext',
  enter: 'engage',
  '=': 'zoomIn',
  '+': 'zoomIn',
  '-': 'zoomOut',
  '?': 'help',
  '/': 'help',
};

/** Standard-mapping gamepad button -> action (fired on press). */
const PAD_ACTIONS: Record<number, Action> = {
  0: 'engage',
  1: 'dockOrLaunch',
  2: 'drop',
  3: 'cycleCraft',
  4: 'zoomOut',
  5: 'zoomIn',
  8: 'jump',
  9: 'helm',
  14: 'targetPrev',
  15: 'targetNext',
};

const PAD_DEADZONE = 0.18;
const MOUSE_FULL_STICK_PX = 180;

/**
 * Turns mouse/keyboard/gamepad into a stick vector plus buttons, like Antopolous's InputManager.
 * Mouse: hold left button to steer toward the cursor, right button for the action.
 */
export class Input {
  private keys = new Set<string>();
  private mouse = { x: 0, y: 0, left: false, right: false };
  private padPrev: boolean[] = [];
  gamepadActive = false;
  /** Return true to consume a left click (e.g. clicking a star on the galaxy map). */
  onClick: (x: number, y: number) => boolean = () => false;
  onAction: (a: Action) => void = () => {};
  onWheel: (delta: number) => void = () => {};

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k === 'tab' || k === ' ') e.preventDefault();
      if (!e.repeat && KEY_ACTIONS[k]) this.onAction(KEY_ACTIONS[k]);
      this.keys.add(k);
      this.gamepadActive = false;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouse.left = this.mouse.right = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.gamepadActive = false;
      if (e.button === 0 && !this.onClick(e.clientX, e.clientY)) this.mouse.left = true;
      if (e.button === 2) this.mouse.right = true;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
    el.addEventListener('pointerup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.onWheel(e.deltaY);
      },
      { passive: false },
    );
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  /** Fire edge-triggered gamepad actions. Call once per frame. */
  pollPad(): void {
    const pad = this.pad();
    if (!pad) return;
    pad.buttons.forEach((b, i) => {
      const was = this.padPrev[i] ?? false;
      if (b.pressed && !was) {
        this.gamepadActive = true;
        const a = PAD_ACTIONS[i];
        if (a) this.onAction(a);
      }
      this.padPrev[i] = b.pressed;
    });
  }

  /** Build this tick's input. `ship` is the controlled ship's screen position (for mouse steering). */
  sample(ship: { x: number; y: number } | null): InputState {
    let sx = 0;
    let sy = 0;
    let boost = this.keys.has('shift');
    let action = this.keys.has(' ') || this.mouse.right;

    const pad = this.pad();
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      const m = Math.hypot(ax, ay);
      if (m > PAD_DEADZONE) {
        this.gamepadActive = true;
        const scaled = Math.min(1, (m - PAD_DEADZONE) / (1 - PAD_DEADZONE));
        sx = (ax / m) * scaled;
        sy = (ay / m) * scaled;
      }
      if ((pad.buttons[7]?.value ?? 0) > 0.3) action = true;
      if ((pad.buttons[6]?.value ?? 0) > 0.3 || pad.buttons[10]?.pressed) boost = true;
    }

    if (sx === 0 && sy === 0 && this.mouse.left && ship) {
      const dx = this.mouse.x - ship.x;
      const dy = this.mouse.y - ship.y;
      const d = Math.hypot(dx, dy);
      if (d > 12) {
        const m = Math.min(1, d / MOUSE_FULL_STICK_PX);
        sx = (dx / d) * m;
        sy = (dy / d) * m;
      }
    }

    if (sx === 0 && sy === 0) {
      const k = this.keys;
      const kx = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
      const ky = (k.has('s') || k.has('arrowdown') ? 1 : 0) - (k.has('w') || k.has('arrowup') ? 1 : 0);
      const m = Math.hypot(kx, ky);
      if (m > 0) {
        sx = kx / m;
        sy = ky / m;
      }
    }
    return { sx, sy, boost, action };
  }
}
