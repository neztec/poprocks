import { useCallback, useEffect, useState } from 'react';
import { api, type AsteroidRow, type EventKind, type EventRow, type Overview, type SystemRow } from './api';

type Tab = 'overview' | 'systems' | 'events';

export function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState<string | null>(null);
  const guard = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);

  return (
    <div className="app">
      <header>
        <h1>POPROCK · admin</h1>
        <nav>
          {(['overview', 'systems', 'events'] as Tab[]).map((t) => (
            <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
      </header>
      {error && <div className="error">{error}</div>}
      {tab === 'overview' && <OverviewTab guard={guard} />}
      {tab === 'systems' && <SystemsTab guard={guard} />}
      {tab === 'events' && <EventsTab guard={guard} />}
    </div>
  );
}

type Guard = (fn: () => Promise<unknown>) => Promise<void>;

// ---- overview ----------------------------------------------------------------

function OverviewTab({ guard }: { guard: Guard }) {
  const [data, setData] = useState<Overview | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    let live = true;
    const load = () => api.overview().then((d) => live && setData(d)).catch(() => live && setData(null));
    load();
    const id = setInterval(load, 2000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  if (!data) return <p className="dim">Waiting for the server on :8080…</p>;
  return (
    <div className="grid">
      <section>
        <h2>Server</h2>
        <p>
          tick {data.tick} · up {Math.floor(data.uptimeSec / 60)}m {data.uptimeSec % 60}s · {data.players.length} online
        </p>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (msg.trim()) void guard(() => api.broadcast(msg.trim()).then(() => setMsg('')));
          }}
        >
          <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Broadcast a message to all players" />
          <button>Send</button>
        </form>
      </section>
      <section>
        <h2>Crews</h2>
        {data.crews.map((c) => (
          <div key={c.id} className="card">
            <b>{c.name}</b> — {c.location}
            {c.autopilotTarget != null && <span className="dim"> (autopilot → #{c.autopilotTarget})</span>}
            <div>
              ferrite {c.resources.ferrite} · auric {c.resources.auric} · carts {c.carts}
            </div>
            <div className="dim">
              helm: {c.members.find((m) => m.id === c.pilotId)?.name ?? 'nobody'} · members:{' '}
              {c.members.map((m) => `${m.name}${m.craft ? ` (${m.craft})` : ''}`).join(', ') || 'none'}
            </div>
          </div>
        ))}
      </section>
      <section>
        <h2>Players</h2>
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th>craft</th>
              <th>cargo</th>
              <th>pos</th>
            </tr>
          </thead>
          <tbody>
            {data.players.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.craft ?? '—'}</td>
                <td>{p.cargo}</td>
                <td>{p.x != null ? `${p.x}, ${p.y}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Systems</h2>
        <table>
          <thead>
            <tr>
              <th>system</th>
              <th>asteroids</th>
              <th>crafts</th>
              <th>carts</th>
              <th>critters</th>
              <th>rail nodes</th>
            </tr>
          </thead>
          <tbody>
            {data.systems.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.asteroids}</td>
                <td>{s.crafts}</td>
                <td>{s.carts}</td>
                <td>{s.critters}</td>
                <td>{s.railNodes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ---- systems -----------------------------------------------------------------

function SystemsTab({ guard }: { guard: Guard }) {
  const [systems, setSystems] = useState<SystemRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const reload = useCallback(() => api.systems().then(setSystems), []);
  useEffect(() => {
    void guard(reload);
  }, [guard, reload]);

  const sys = systems.find((s) => s.id === selected) ?? systems[0];

  return (
    <div className="split">
      <aside>
        <GalaxyMap systems={systems} selected={sys?.id ?? null} onSelect={setSelected} />
        <ul className="list">
          {systems.map((s) => (
            <li key={s.id} className={s.id === sys?.id ? 'active' : ''} onClick={() => setSelected(s.id)}>
              <span className="dot" style={{ background: s.color }} /> {s.name}
            </li>
          ))}
        </ul>
        <button
          onClick={() =>
            guard(async () => {
              const { id } = await api.createSystem({ name: 'New System', gx: 0, gy: 0, color: '#ffffff' });
              await reload();
              setSelected(id);
            })
          }
        >
          + New system
        </button>
      </aside>
      {sys && <SystemEditor key={sys.id} sys={sys} guard={guard} reload={reload} />}
    </div>
  );
}

function SystemEditor({ sys, guard, reload }: { sys: SystemRow; guard: Guard; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState(sys);
  const [bodies, setBodies] = useState(JSON.stringify(sys.def.bodies, null, 1));
  const [placing, setPlacing] = useState<{ x: number; y: number } | null>(null);

  const save = () =>
    guard(async () => {
      const parsed = JSON.parse(bodies);
      await api.updateSystem({ ...draft, def: { ...draft.def, bodies: parsed } });
      await reload();
    });

  return (
    <div className="editor">
      <section>
        <h2>{sys.name}</h2>
        <div className="form">
          <label>
            name <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            color <input type="color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
          </label>
          <label>
            galaxy x <NumInput value={draft.gx} onChange={(gx) => setDraft({ ...draft, gx })} />
          </label>
          <label>
            galaxy y <NumInput value={draft.gy} onChange={(gy) => setDraft({ ...draft, gy })} />
          </label>
          <label>
            park x <NumInput value={draft.def.park.x} onChange={(x) => setDraft({ ...draft, def: { ...draft.def, park: { ...draft.def.park, x } } })} />
          </label>
          <label>
            park y <NumInput value={draft.def.park.y} onChange={(y) => setDraft({ ...draft, def: { ...draft.def, park: { ...draft.def.park, y } } })} />
          </label>
          <label>
            wildlife target <NumInput value={draft.def.critters} onChange={(critters) => setDraft({ ...draft, def: { ...draft.def, critters } })} />
          </label>
        </div>
        <label className="block">
          gravity bodies (JSON: x, y, radius, mass — the first is the star)
          <textarea rows={5} value={bodies} onChange={(e) => setBodies(e.target.value)} />
        </label>
        <div className="actions">
          <button className="primary" onClick={save}>
            Save system
          </button>
          <button
            onClick={() => {
              if (confirm('Remove every rail in this system?')) void guard(() => api.clearRails(sys.id));
            }}
          >
            Clear rails
          </button>
          <button
            className="danger"
            onClick={() => {
              if (confirm(`Delete ${sys.name} and its asteroids?`)) void guard(() => api.deleteSystem(sys.id).then(reload));
            }}
          >
            Delete system
          </button>
        </div>
      </section>

      <section>
        <h2>Layout</h2>
        <p className="dim">Click the map to place a new asteroid.</p>
        <SystemMap sys={{ ...draft, asteroids: sys.asteroids }} marker={placing} onPick={setPlacing} />
        {placing && (
          <NewAsteroid
            at={placing}
            onCancel={() => setPlacing(null)}
            onCreate={(a) =>
              guard(async () => {
                await api.addAsteroid(sys.id, a);
                setPlacing(null);
                await reload();
              })
            }
          />
        )}
      </section>

      <section>
        <h2>Asteroids</h2>
        <p className="dim">Saving an asteroid regenerates it from its seed — that wipes all tunnels in it.</p>
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th>x</th>
              <th>y</th>
              <th>radius</th>
              <th>seed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sys.asteroids.map((a) => (
              <AsteroidRowEditor key={a.id} ast={a} guard={guard} reload={reload} />
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function AsteroidRowEditor({ ast, guard, reload }: { ast: AsteroidRow; guard: Guard; reload: () => Promise<void> }) {
  const [a, setA] = useState(ast);
  return (
    <tr>
      <td>
        <input value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} />
      </td>
      <td>
        <NumInput value={a.x} onChange={(x) => setA({ ...a, x })} />
      </td>
      <td>
        <NumInput value={a.y} onChange={(y) => setA({ ...a, y })} />
      </td>
      <td>
        <NumInput value={a.radius} onChange={(radius) => setA({ ...a, radius })} />
      </td>
      <td>
        <NumInput value={a.seed} onChange={(seed) => setA({ ...a, seed })} />
      </td>
      <td className="nowrap">
        <button
          onClick={() => {
            if (confirm(`Regenerate ${a.name}? Existing tunnels are lost.`)) void guard(() => api.updateAsteroid(a).then(reload));
          }}
        >
          Save &amp; regenerate
        </button>
        <button
          className="danger"
          onClick={() => {
            if (confirm(`Delete ${a.name}?`)) void guard(() => api.deleteAsteroid(a.id).then(reload));
          }}
        >
          ✕
        </button>
      </td>
    </tr>
  );
}

function NewAsteroid({ at, onCreate, onCancel }: { at: { x: number; y: number }; onCreate: (a: Partial<AsteroidRow>) => void; onCancel: () => void }) {
  const [radius, setRadius] = useState(1500);
  const [name, setName] = useState('New asteroid');
  return (
    <div className="card">
      <div className="form">
        <label>
          name <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          radius <NumInput value={radius} onChange={setRadius} />
        </label>
        <span className="dim">
          at {Math.round(at.x)}, {Math.round(at.y)}
        </span>
      </div>
      <div className="actions">
        <button className="primary" onClick={() => onCreate({ name, x: Math.round(at.x), y: Math.round(at.y), radius, seed: Math.floor(Math.random() * 1e9) })}>
          Create
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Top-down sketch of a system: star/bodies, asteroids, parking spot. */
function SystemMap({ sys, marker, onPick }: { sys: SystemRow; marker: { x: number; y: number } | null; onPick: (p: { x: number; y: number }) => void }) {
  const R = 12000;
  return (
    <svg
      className="map"
      viewBox={`${-R} ${-R} ${R * 2} ${R * 2}`}
      onClick={(e) => {
        const svg = e.currentTarget;
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
        onPick({ x: p.x, y: p.y });
      }}
    >
      <rect x={-R} y={-R} width={R * 2} height={R * 2} fill="#070a14" />
      {sys.def.bodies.map((b, i) => (
        <circle key={i} cx={b.x} cy={b.y} r={b.radius} fill={i === 0 ? sys.color : '#56648c'} />
      ))}
      {sys.asteroids.map((a) => (
        <g key={a.id}>
          <circle cx={a.x} cy={a.y} r={a.radius} fill="#4a4f60" stroke="#8a8f9e" strokeWidth={40} />
          <text x={a.x} y={a.y} fill="#dfe6ff" fontSize={500} textAnchor="middle">
            {a.name}
          </text>
        </g>
      ))}
      <circle cx={sys.def.park.x} cy={sys.def.park.y} r={280} fill="none" stroke="#8fa8ff" strokeWidth={60} />
      <text x={sys.def.park.x} y={sys.def.park.y - 400} fill="#8fa8ff" fontSize={400} textAnchor="middle">
        park
      </text>
      {marker && <circle cx={marker.x} cy={marker.y} r={200} fill="#00ffcc" />}
    </svg>
  );
}

function GalaxyMap({ systems, selected, onSelect }: { systems: SystemRow[]; selected: number | null; onSelect: (id: number) => void }) {
  const R = 18000;
  return (
    <svg className="map small" viewBox={`${-R} ${-R} ${R * 2} ${R * 2}`}>
      <rect x={-R} y={-R} width={R * 2} height={R * 2} fill="#070a14" />
      {systems.map((s) => (
        <g key={s.id} onClick={() => onSelect(s.id)} style={{ cursor: 'pointer' }}>
          <circle cx={s.gx} cy={s.gy} r={s.id === selected ? 700 : 450} fill={s.color} stroke={s.id === selected ? '#fff' : 'none'} strokeWidth={150} />
        </g>
      ))}
    </svg>
  );
}

// ---- events ------------------------------------------------------------------

const PARAM_TEMPLATES: Record<EventKind, Record<string, unknown>> = {
  broadcast: { message: 'Hello, crew.' },
  spawnCritters: { systemId: 1, count: 8 },
  oreBloom: { systemId: 1, count: 3, radius: 120 },
  grantResources: { ferrite: 50, auric: 0 },
};

const KIND_HELP: Record<EventKind, string> = {
  broadcast: 'Show a message to players (optionally only in systemId).',
  spawnCritters: 'Add glimmers to a system.',
  oreBloom: 'Turn patches of rock into ferrite inside a system’s asteroids.',
  grantResources: 'Give every crew ferrite/auric.',
};

function EventsTab({ guard }: { guard: Guard }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const reload = useCallback(() => api.events().then(setEvents), []);
  useEffect(() => {
    void guard(reload);
  }, [guard, reload]);

  return (
    <div>
      <p className="dim">
        Events fire <b>delay</b> seconds after the server starts (or after being enabled), then every <b>repeat</b> seconds. Repeat 0 = once (it
        disables itself after firing). “Fire now” doesn’t use up a one-shot event.
      </p>
      {events.map((e) => (
        <EventEditor key={`${e.id}:${e.lastFired}:${e.enabled}`} ev={e} guard={guard} reload={reload} />
      ))}
      <button
        onClick={() =>
          guard(async () => {
            await api.createEvent({ name: 'New event', kind: 'broadcast', params: PARAM_TEMPLATES.broadcast, delaySec: 10, repeatSec: 0, enabled: false });
            await reload();
          })
        }
      >
        + New event
      </button>
    </div>
  );
}

function EventEditor({ ev, guard, reload }: { ev: EventRow; guard: Guard; reload: () => Promise<void> }) {
  const [e, setE] = useState(ev);
  const [params, setParams] = useState(JSON.stringify(ev.params, null, 1));
  const [result, setResult] = useState<string | null>(null);

  return (
    <div className="card event">
      <div className="form">
        <label>
          name <input value={e.name} onChange={(x) => setE({ ...e, name: x.target.value })} />
        </label>
        <label>
          kind
          <select
            value={e.kind}
            onChange={(x) => {
              const kind = x.target.value as EventKind;
              setE({ ...e, kind });
              setParams(JSON.stringify(PARAM_TEMPLATES[kind], null, 1));
            }}
          >
            {Object.keys(PARAM_TEMPLATES).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label>
          delay s <NumInput value={e.delaySec} onChange={(delaySec) => setE({ ...e, delaySec })} />
        </label>
        <label>
          repeat s <NumInput value={e.repeatSec} onChange={(repeatSec) => setE({ ...e, repeatSec })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={e.enabled} onChange={(x) => setE({ ...e, enabled: x.target.checked })} /> enabled
        </label>
      </div>
      <div className="dim">{KIND_HELP[e.kind]}</div>
      <textarea rows={3} value={params} onChange={(x) => setParams(x.target.value)} />
      <div className="actions">
        <button className="primary" onClick={() => guard(() => api.updateEvent({ ...e, params: JSON.parse(params) }).then(reload))}>
          Save
        </button>
        <button onClick={() => guard(() => api.triggerEvent(e.id).then((r) => setResult(r.result)))}>Fire now</button>
        <button
          className="danger"
          onClick={() => {
            if (confirm(`Delete event “${e.name}”?`)) void guard(() => api.deleteEvent(e.id).then(reload));
          }}
        >
          Delete
        </button>
        <span className="dim">
          {ev.lastFired ? `last fired ${new Date(ev.lastFired).toLocaleTimeString()}` : 'never fired'}
          {result && ` · ${result}`}
        </span>
      </div>
    </div>
  );
}

function NumInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      className="num"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n);
      }}
    />
  );
}
