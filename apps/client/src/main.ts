import { CRAFT_KINDS, DT, type CraftKind } from '@poprock/shared';
import { Hud } from './hud';
import { Input, type Action } from './input';
import { Net, serverUrl } from './net';
import { Scene } from './render/scene';
import { World } from './world';

const form = document.getElementById('join') as HTMLFormElement;
const nameInput = document.getElementById('name') as HTMLInputElement;
try {
  nameInput.value = localStorage.getItem('poprock.name') ?? '';
} catch {
  /* storage unavailable */
}
nameInput.focus();

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim() || `Pilot${Math.floor(Math.random() * 900 + 100)}`;
  try {
    localStorage.setItem('poprock.name', name);
  } catch {
    /* storage unavailable */
  }
  form.remove();
  void start(name);
});

async function start(name: string): Promise<void> {
  const scene = new Scene();
  await scene.init(document.getElementById('app')!);
  const world = new World();
  const hud = new Hud(document.getElementById('hud')!);
  const input = new Input(scene.canvas);
  const net = new Net(serverUrl(), name);

  let selectedCraft: CraftKind = 'driller';
  let selectedTarget: number | null = null;

  net.onMessage = (m) => world.handle(m);
  net.onStatus = (ok) => hud.setConnected(ok);
  world.onToast = (t) => hud.toast(t);
  world.onPaint = (x, y, r, m) => scene.burst(x, y, r, m);

  const inCraft = () => !!world.you?.ship && world.you.ship.kind !== 'mothership';

  const act = (a: Action) => {
    switch (a) {
      case 'launchScout':
        return launch('scout');
      case 'launchDriller':
        return launch('driller');
      case 'launchLayer':
        return launch('layer');
      case 'dock':
        return net.send({ t: 'dock' });
      case 'dockOrLaunch':
        return inCraft() ? net.send({ t: 'dock' }) : launch(selectedCraft);
      case 'cycleCraft':
        selectedCraft = CRAFT_KINDS[(CRAFT_KINDS.indexOf(selectedCraft) + 1) % CRAFT_KINDS.length];
        return;
      case 'helm':
        return net.send({ t: 'helm', take: world.crew?.pilotId !== world.playerId });
      case 'jump':
        return net.send({ t: 'jump' });
      case 'drop':
        return net.send({ t: 'dropCargo' });
      case 'buildCart':
        return net.send({ t: 'buildCart' });
      case 'targetNext':
      case 'targetPrev': {
        const list = world.systems;
        if (list.length === 0) return;
        const i = list.findIndex((s) => s.id === selectedTarget);
        const step = a === 'targetNext' ? 1 : -1;
        selectedTarget = list[(i + step + list.length) % list.length].id;
        return;
      }
      case 'engage':
        if (world.space?.kind === 'galaxy' && selectedTarget != null) net.send({ t: 'autopilot', systemId: selectedTarget });
        return;
      case 'zoomIn':
        return scene.zoomBy(1.25);
      case 'zoomOut':
        return scene.zoomBy(0.8);
      case 'help':
        return hud.toggleHelp();
    }
  };

  const launch = (craft: CraftKind) => {
    selectedCraft = craft;
    if (!inCraft()) net.send({ t: 'launch', craft });
  };

  input.onAction = act;
  hud.onAction = act;
  input.onWheel = (dy) => scene.zoomBy(dy > 0 ? 0.9 : 1.1);
  input.onClick = (x, y) => {
    const s = scene.systemAt(world, x, y);
    if (!s) return false;
    selectedTarget = s.id;
    if (world.crew?.pilotId === world.playerId) net.send({ t: 'autopilot', systemId: s.id });
    return true;
  };

  // Fixed-rate input + prediction, decoupled from render rate.
  let acc = 0;
  let hudTimer = 0;
  scene.app.ticker.add((ticker) => {
    const dt = Math.min(0.1, ticker.deltaMS / 1000);
    input.pollPad();
    acc += dt;
    while (acc >= DT) {
      acc -= DT;
      const own = world.predicted ? world.ents.get(world.predicted.id) : null;
      const screen = own ? scene.worldToScreen(own.x, own.y) : null;
      const msg = world.tick(input.sample(screen));
      net.send({ t: 'input', seq: msg.seq, i: msg.i });
    }
    world.frame(dt);
    scene.render(world, dt, selectedTarget);
    hudTimer -= dt;
    if (hudTimer <= 0) {
      hudTimer = 0.15;
      hud.update(world, selectedCraft, selectedTarget, input.gamepadActive);
    }
  });
}
