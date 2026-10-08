import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as api from "./backend";
import Piano88, { AnalogResponse } from "./Piano88";
import type {
  Snapshot,
  Settings,
  Profile,
  Project,
  Route,
  Source,
  Destination,
} from "./backend";

const tabs = ["Play", "Mapping", "Settings"] as const;
type Tab = (typeof tabs)[number] | "Sequencer";
const channels = Array.from({ length: 16 }, (_, i) => i);
export const keyLabel = (hid: number) =>
  hid >= 4 && hid <= 29
    ? String.fromCharCode(65 + hid - 4)
    : hid >= 30 && hid <= 38
      ? String(hid - 29)
      : ((
          {
            39: "0",
            40: "Enter",
            41: "Escape",
            42: "Backspace",
            43: "Tab",
            44: "Space",
            225: "Left Shift",
          } as Record<number, string>
        )[hid] ?? `HID ${hid}`);
const noteLabel = (note: number) =>
  `${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][note % 12]}${Math.floor(note / 12) - 1}`;
const sourceValue = (source: Source) =>
  source.kind === "sequencer" ? `track:${source.track}` : source.kind;
const sourceFrom = (value: string): Source =>
  value.startsWith("track:")
    ? { kind: "sequencer", track: +value.slice(6) }
    : { kind: value as "midi" | "analog" };
const destinationValue = (destination: Destination) =>
  destination.kind === "qwerty"
    ? "qwerty"
    : `${destination.kind}:${destination.id}`;
const destinationFrom = (value: string): Destination =>
  value === "qwerty"
    ? { kind: "qwerty" }
    : value.startsWith("recorder:")
      ? { kind: "recorder", id: +value.slice(9) }
      : { kind: "midi", id: value.slice(5) };
function Channel({
  value,
  onChange,
  all = false,
  label,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  all?: boolean;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : +e.target.value)}
    >
      {all && <option value="">All / unchanged</option>}
      {channels.map((c) => (
        <option key={c} value={c}>
          {c + 1}
        </option>
      ))}
    </select>
  );
}
function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
function Status({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={`status ${active ? "connected" : ""}`}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

function isEditor(target: EventTarget | null): boolean {
  return target instanceof Element && target.matches(
    "input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true]",
  );
}

export default function App() {
  const [state, setState] = useState<Snapshot>(api.initialState);
  const pauseReasons = useRef({ mapping: Symbol("mapping"), editor: Symbol("editor") });
  const pendingOperations = useRef(0);
  function acceptSnapshot(snapshot: Snapshot) {
    setState(previous => snapshot.state_sequence >= previous.state_sequence ? snapshot : previous);
  }
  const stateRef = useRef(state);
  stateRef.current = state;
  const [tab, setTab] = useState<Tab>("Play");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [mapping, setMapping] = useState<"qwerty" | "analog">("analog");
  const [stepIndex, setStepIndex] = useState(0);
  const [stepText, setStepText] = useState("");
  const [stepGate, setStepGate] = useState(80);
  const [learn, setLearn] = useState<number | null>(null);
  const learnReceived = useRef(0);
  const [maximized, setMaximized] = useState(false);
  const mac = /Mac/.test(navigator.platform);
  const profile = state.settings.profiles.find(
    (p) => p.id === state.settings.selected_profile,
  )!;
  const working = draft ?? state.settings;
  const workingProfile = working.profiles.find(
    (p) => p.id === working.selected_profile,
  )!;
  const selectedStep = state.project.tracks[state.armed_track].steps[stepIndex];
  const selectedStepKey = JSON.stringify(selectedStep);

  useEffect(() => {
    let live = true;
    let dispose = () => {};
    api
      .getState()
      .then(async (s) => {
        if (live) {
          acceptSnapshot(s);
          setMapping(s.settings.input_mode === "analog" ? "analog" : "qwerty");
          await api.nativeSmokeReady(s.native_smoke === true);
        }
      })
      .catch((e) => setError(api.errorText(e)));
    api
      .subscribe((s) => {
        if (live) acceptSnapshot(s);
      })
      .then((fn) => {
        if (live) dispose = fn;
        else fn();
      })
      .catch((e) => setError(api.errorText(e)));
    return () => {
      live = false;
      dispose();
    };
  }, []);
  useEffect(() => {
    const reasons = pauseReasons.current;
    return () => {
      void api.pauseOutput(reasons.mapping, false).catch(() => {});
      void api.pauseOutput(reasons.editor, false).catch(() => {});
    };
  }, []);
  useEffect(() => {
    setStepText(
      selectedStep.notes.map((n) => `${n.note}:${n.velocity}`).join(", "),
    );
    setStepGate(Math.round(selectedStep.gate * 100));
  }, [selectedStepKey, state.armed_track, stepIndex]);
  useEffect(() => {
    if (
      learn === null ||
      state.received <= learnReceived.current ||
      !state.last_event ||
      (state.last_event.status & 0xf0) !== 0x90
    )
      return;
    const note = state.last_event;
    editProfile((p) => {
      p.qwerty[learn].note = note.data1;
      p.qwerty[learn].channel = note.status & 15;
    });
    setLearn(null);
  }, [state.received, state.last_event, learn]);
  useEffect(() => {
    if (!api.desktop) return;
    const window = getCurrentWindow();
    let dispose = () => {};
    window
      .onResized(() => {
        window
          .isMaximized()
          .then(setMaximized)
          .catch(() => {});
      })
      .then((fn) => (dispose = fn));
    return () => dispose();
  }, []);
  async function run(operation: () => Promise<void | Snapshot>) {
    pendingOperations.current++;
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (result) acceptSnapshot(result);
    } catch (e) {
      setError(api.errorText(e));
    } finally {
      setBusy(--pendingOperations.current > 0);
    }
  }
  const send = (type: string, fields: Record<string, unknown> = {}) =>
    run(() => api.command({ type, ...fields }));
  const pause = (reason: symbol, active: boolean) => api.pauseOutput(reason, active)
    .then(result => { if (result) acceptSnapshot(result); })
    .catch(error => setError(api.errorText(error)));
  function editSettings(change: (settings: Settings) => void) {
    setDraft((existing) => {
      const next = api.clone(existing ?? stateRef.current.settings);
      change(next);
      return next;
    });
    if (!draft) setDraftRevision(state.revision);
  }
  function editProfile(change: (profile: Profile) => void) {
    editSettings((s) =>
      change(s.profiles.find((p) => p.id === s.selected_profile)!),
    );
  }
  async function applySettings(
    settings: Settings,
    revision = stateRef.current.revision,
  ) {
    const result = await api.command({
      type: "settings",
      settings,
      expected_revision: revision,
    });
    setDraft(null);
    return result;
  }
  function immediate(change: (settings: Settings) => void) {
    run(async () => {
      if (draft && !(await api.ask("Discard the unsaved profile draft?")))
        return;
      const settings = api.clone(stateRef.current.settings);
      change(settings);
      return applySettings(settings);
    });
  }
  function switchTab(next: Tab) {
    setTab(next);
    pause(pauseReasons.current.mapping, next === "Mapping");
    pause(pauseReasons.current.editor, false);
    setLearn(null);
  }
  function updateProject(change: (project: Project) => void) {
    const next = api.clone(stateRef.current.project);
    change(next);
    run(() =>
      api.command({
        type: "project",
        project: next,
        expected_revision: stateRef.current.revision,
      }),
    );
  }
  function selectStep(index: number) {
    setStepIndex(index);
    if (!state.playing) send("cursor", { step: index });
  }
  function addRoute() {
    editProfile((p) =>
      p.routes.push({
        id: `route-${Date.now()}`,
        source: { kind: "midi" },
        destination: { kind: "qwerty" },
        enabled: false,
        channel: null,
        remap_channel: null,
      }),
    );
  }
  function setOutput(id: string) {
    immediate((s) => {
      const p = s.profiles.find((p) => p.id === s.selected_profile)!;
      p.routes = p.routes.filter(
        (r) =>
          !(r.destination.kind === "midi" && r.source.kind !== "sequencer"),
      );
      if (id)
        for (const kind of ["midi", "analog"] as const)
          p.routes.push({
            id: `output-${kind}`,
            source: { kind },
            destination: { kind: "midi", id },
            enabled: true,
            channel: null,
            remap_channel: null,
          });
    });
  }
  function trackRoute(track: number, value: string) {
    immediate((s) => {
      const p = s.profiles.find((p) => p.id === s.selected_profile)!;
      p.routes = p.routes.filter(
        (r) => !(r.source.kind === "sequencer" && r.source.track === track),
      );
      if (value)
        p.routes.push({
          id: `track-${track}`,
          source: { kind: "sequencer", track },
          destination: destinationFrom(value),
          enabled: true,
          channel: null,
          remap_channel: value === "qwerty" ? 0 : null,
        });
    });
  }
  async function fileProject(writing: boolean) {
    if (
      !writing &&
      stateRef.current.project_dirty &&
      !(await api.ask("Discard unsaved project changes?"))
    )
      return;
    const path = await api.chooseFile("project", writing);
    if (path) return api.projectFile(path, writing);
  }
  const status = state.analog_enabled || !!state.midi_connected;
  const rows =
    mapping === "qwerty"
      ? workingProfile.qwerty
      : Object.entries(workingProfile.analog.keymapping).flatMap(
          ([channel, pairs]) =>
            pairs.map(([hid, note]) => ({ channel: +channel, hid, note })),
        );
  function editRow(
    index: number,
    change: Partial<{ channel: number; note: number; hid: number }>,
  ) {
    editProfile((p) => {
      if (mapping === "qwerty") Object.assign(p.qwerty[index], change);
      else {
        const next = rows.map((r, i) =>
          i === index ? { ...r, ...change } : r,
        );
        p.analog.keymapping = {};
        for (const r of next)
          (p.analog.keymapping[r.channel] ??= []).push([r.hid, r.note]);
      }
    });
  }
  function removeRow(index: number) {
    editProfile((p) => {
      if (mapping === "qwerty") p.qwerty.splice(index, 1);
      else {
        p.analog.keymapping = {};
        rows
          .filter((_, i) => i !== index)
          .forEach((r) =>
            (p.analog.keymapping[r.channel] ??= []).push([r.hid, r.note]),
          );
      }
    });
  }

  return (
    <div className="app">
      <header className={`titlebar ${mac ? "mac" : ""}`}>
        <div
          className="drag-region"
          data-tauri-drag-region
          onDoubleClick={() => {
            if (api.desktop)
              getCurrentWindow()
                .toggleMaximize()
                .catch((e) => setError(api.errorText(e)));
          }}
        >
          <span className="brand" data-tauri-drag-region>
            lazymidi
          </span>
        </div>
        <button
          className="panic"
          disabled={busy}
          onClick={() => send("panic")}
          title="Release all generated keys and notes; stop transport"
        >
          Panic
        </button>
        {!mac && (
          <div className="window-controls">
            <button
              aria-label="Minimize window"
              onClick={() => {
                if (api.desktop)
                  getCurrentWindow()
                    .minimize()
                    .catch((e) => setError(api.errorText(e)));
              }}
            >
              —
            </button>
            <button
              aria-label={maximized ? "Restore window" : "Maximize window"}
              onClick={() => {
                if (api.desktop)
                  getCurrentWindow()
                    .toggleMaximize()
                    .catch((e) => setError(api.errorText(e)));
              }}
            >
              {maximized ? "▱" : "□"}
            </button>
            <button
              className="close"
              aria-label="Close window"
              onClick={() => run(() => api.closeApp(state.project_dirty))}
            >
              ×
            </button>
          </div>
        )}
      </header>
      <nav className="navigation" aria-label="Main navigation">
        <div
          role="tablist"
          aria-label="Application sections"
          onKeyDown={(e) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
              return;
            e.preventDefault();
            const index =
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? tabs.length - 1
                  : (tabs.findIndex((t) => t === tab) +
                      (e.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                    tabs.length;
            switchTab(tabs[index]);
            document.getElementById(`tab-${tabs[index]}`)?.focus();
          }}
        >
          {tabs.map((t) => (
            <button
              key={t}
              role="tab"
              tabIndex={tab === t ? 0 : -1}
              aria-selected={tab === t}
              aria-controls={`panel-${t}`}
              id={`tab-${t}`}
              onClick={() => switchTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="nav-status">
          <Status active={status}>
            {status ? "Input connected" : "Waiting for input"}
          </Status>
        </span>
      </nav>
      {(error || state.error || state.warning) && (
        <div
          className={`notice ${error || state.error ? "error" : ""}`}
          role={error || state.error ? "alert" : "status"}
        >
          {error ?? state.error ?? state.warning}
          {error && (
            <button aria-label="Dismiss error" onClick={() => setError(null)}>
              ×
            </button>
          )}
        </div>
      )}
      <main
        id={`panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        onFocusCapture={(e) => {
          pause(pauseReasons.current.editor, isEditor(e.target));
        }}
        onBlurCapture={(e) => {
          pause(pauseReasons.current.editor, isEditor(e.relatedTarget));
        }}
      >
        {tab === "Play" && (
          <div className="split play">
            <section className="primary-panel">
              <div className="section-heading">
                <h1>Play</h1>
              </div>
              <div className="segmented" aria-label="Player input">
                {(["analog", "midi"] as const).map((mode) => (
                  <button
                    key={mode}
                    aria-pressed={state.settings.input_mode === mode}
                    disabled={busy}
                    onClick={() => {
                      setMapping(mode === "analog" ? "analog" : "qwerty");
                      immediate((s) => (s.input_mode = mode));
                    }}
                  >
                    {mode === "analog" ? "Analog Keyboard" : "MIDI Controller"}
                  </button>
                ))}
              </div>
              {state.settings.input_mode === "analog" ? (
                <div className="control-block">
                  <div className="section-heading">
                    <h2>Analog input</h2>
                    <Status active={state.analog_enabled}>
                      {state.analog_pending
                        ? "Connecting…"
                        : state.analog_enabled
                          ? "Enabled"
                          : "Off"}
                    </Status>
                  </div>
                  <label className="field">
                    Wooting device
                    <select
                      value={state.settings.analog_device ?? ""}
                      disabled={busy || !state.analog_devices.length}
                      onChange={(e) =>
                        immediate(
                          (s) => (s.analog_device = e.target.value || null),
                        )
                      }
                    >
                      <option value="">Auto-select a single device</option>
                      {state.analog_devices.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="inline-control">
                    <Toggle
                      label="Enable analog input"
                      checked={state.analog_enabled}
                      disabled={busy || state.analog_pending}
                      onChange={(enabled) => send("analog", { enabled })}
                    />
                    <span className="muted">
                      {state.sdk_version
                        ? `SDK ${state.sdk_version}`
                        : state.sdk_found
                          ? "Installed SDK found"
                          : "SDK not found"}
                    </span>
                  </div>
                  {state.analog_enabled && (
                    <>
                      <AnalogResponse profile={workingProfile} edit={editProfile} />
                      {draft && (
                        <div className="button-row">
                          <button disabled={busy} className="primary" onClick={() => run(() => applySettings(draft, draftRevision))}>
                            Apply analog settings
                          </button>
                          <button disabled={busy} onClick={() => setDraft(null)}>Discard draft</button>
                        </div>
                      )}
                    </>
                  )}
                  <p className="help">
                    Physical typing stays active; disable mapped digital keys in Wootility.
                  </p>
                  {!state.sdk_found && (
                    <button onClick={() => switchTab("Settings")}>
                      SDK setup
                    </button>
                  )}
                </div>
              ) : (
                <div className="control-block">
                  <div className="section-heading">
                    <h2>MIDI input</h2>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => send("refresh")}
                    >
                      Refresh
                    </button>
                  </div>
                  <label className="field">
                    Controller
                    <select
                      value={state.settings.preferred_midi ?? ""}
                      disabled={busy}
                      onChange={(e) =>
                        immediate(
                          (s) => (s.preferred_midi = e.target.value || null),
                        )
                      }
                    >
                      <option value="">Automatic · one available input</option>
                      {state.inputs.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                      {state.settings.preferred_midi &&
                        !state.inputs.some(
                          (d) => d.id === state.settings.preferred_midi,
                        ) && (
                          <option value={state.settings.preferred_midi}>
                            Remembered device · disconnected
                          </option>
                        )}
                    </select>
                  </label>
                  <Status active={!!state.midi_connected}>
                    {state.midi_connected
                      ? (state.inputs.find((d) => d.id === state.midi_connected)
                          ?.name ?? "Connected")
                      : state.inputs.length > 1
                        ? "Choose a controller"
                        : "No controller connected"}
                  </Status>
                  <p className="help">
                    Devices reconnect automatically. Generated keystrokes always
                    require your toggle.
                  </p>
                </div>
              )}
              <div className="control-block output-block">
                <div className="section-heading">
                  <h2>Keyboard output</h2>
                  <Status active={state.qwerty_enabled}>
                    {state.qwerty_pending
                      ? "Checking permissions…"
                      : state.qwerty_enabled
                        ? state.paused
                          ? "Paused"
                          : "Enabled"
                        : "Off"}
                  </Status>
                </div>
                <Toggle
                  label="MIDI → QWERTY"
                  checked={state.qwerty_enabled}
                  disabled={busy || state.qwerty_pending}
                  onChange={(enabled) => send("qwerty", { enabled })}
                />
                <p className="help">
                  Disable output before typing or changing applications.
                </p>
                <div className="details-row">
                  <span className="muted">Native output</span>
                  <span>{state.keyboard_backend}</span>
                </div>
                {state.paused && (
                  <button onClick={() => pause(pauseReasons.current.editor, false)}>
                    Resume generated keys
                  </button>
                )}
              </div>
              <details className="advanced">
                <summary>
                  Advanced routing{" "}
                  <span className="muted">
                    {profile.routes.filter((r) => r.enabled).length} active
                    routes
                  </span>
                </summary>
                <Toggle
                  label="Allow both input sources"
                  checked={state.settings.both_inputs}
                  disabled={busy}
                  onChange={(enabled) =>
                    immediate((s) => (s.both_inputs = enabled))
                  }
                />
                <p className="help">
                  Both live sources share one engine. Recording follows the
                  armed track; playback cannot feed its recorder.
                </p>
                <Routes
                  routes={workingProfile.routes}
                  outputs={state.outputs}
                  edit={(change) => editProfile((p) => change(p.routes))}
                  add={addRoute}
                />
                {draft && (
                  <div className="button-row">
                    <button
                      disabled={busy}
                      className="primary"
                      onClick={() =>
                        run(() => applySettings(draft, draftRevision))
                      }
                    >
                      Apply routes
                    </button>
                    <button onClick={() => setDraft(null)}>
                      Discard draft
                    </button>
                  </div>
                )}
                <p className="help">
                  External software can create MIDI loops. Avoid routing an
                  output back to the selected input.
                </p>
              </details>
            </section>
            <aside className="secondary-panel">
              <div className="section-heading">
                <h2>Profile</h2>
                <button
                  className="text-button"
                  onClick={() => switchTab("Mapping")}
                >
                  Edit mapping
                </button>
              </div>
              <label className="field">
                <span className="sr-only">Active profile</span>
                <select
                  aria-label="Active profile"
                  disabled={busy}
                  value={state.settings.selected_profile}
                  onChange={(e) =>
                    immediate((s) => (s.selected_profile = e.target.value))
                  }
                >
                  {state.settings.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="help">
                {profile.qwerty.length} MIDI-to-key bindings ·{" "}
                {Object.values(profile.analog.keymapping).flat().length} analog
                bindings
              </p>
              <div className="activity">
                <div className="section-heading">
                  <h2>Activity</h2>
                  <span className="muted">
                    {state.received.toLocaleString()} events
                  </span>
                </div>
                {state.active_notes.length ? (
                  <div className="note-list">
                    {state.active_notes.map(([s, c, n], i) => (
                      <span key={`${sourceValue(s)}-${c}-${n}-${i}`}>
                        {noteLabel(n)}
                        <small>Ch {c + 1}</small>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="empty">
                    <span>No active notes</span>
                    <small>
                      {state.last_event
                        ? `Last event: channel ${(state.last_event.status & 15) + 1}, value ${state.last_event.data1}`
                        : "Input activity will appear here."}
                    </small>
                  </div>
                )}
              </div>
              <div className="control-block">
                <h2>MIDI destination</h2>
                <label className="field">
                  Live MIDI output
                  <select
                    value={
                      profile.routes.find(
                        (r) =>
                          r.enabled &&
                          r.source.kind !== "sequencer" &&
                          r.destination.kind === "midi",
                      )?.destination.kind === "midi"
                        ? (
                            profile.routes.find(
                              (r) =>
                                r.enabled &&
                                r.source.kind !== "sequencer" &&
                                r.destination.kind === "midi",
                            )!.destination as { id: string }
                          ).id
                        : ""
                    }
                    disabled={busy}
                    onChange={(e) => setOutput(e.target.value)}
                  >
                    <option value="">None · internal processing only</option>
                    {state.outputs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>

              </div>

            </aside>
          </div>
        )}
        {tab === "Mapping" && (
          <div className="mapping-wrap">
            <Piano88
              profile={workingProfile}
              direction={mapping}
              onDirection={(direction) => {
                setMapping(direction);
                setLearn(null);
              }}
              active={state.active_notes}
              edit={editProfile}
              busy={busy}
            />
            <div
              className="split mapping"
            >
              <section className="primary-panel">
                <div className="section-heading">
                  <h1>Mapping</h1>
                </div>
                <div className="toolbar">
                  <span className="muted">{rows.length} bindings</span>
                  <button
                    onClick={() =>
                      editProfile((p) => {
                        if (mapping === "qwerty")
                          p.qwerty.push({ channel: 0, note: 60, hid: 4 });
                        else (p.analog.keymapping["0"] ??= []).push([4, 60]);
                      })
                    }
                  >
                    Add binding
                  </button>
                </div>
                <div className="table-scroll">
                  <table className="mapping-table">
                    <thead>
                      <tr>
                        <th>Channel</th>
                        <th>MIDI note</th>
                        <th>Physical key</th>
                        <th>HID usage</th>
                        <th>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i}>
                          <td>
                            <Channel
                              label={`Channel for binding ${i + 1}`}
                              value={r.channel}
                              onChange={(channel) =>
                                editRow(i, { channel: channel! })
                              }
                            />
                          </td>
                          <td>
                            <div className="note-input">
                              <input
                                aria-label={`Note for binding ${i + 1}`}
                                type="number"
                                min="0"
                                max="127"
                                value={r.note}
                                onChange={(e) =>
                                  editRow(i, { note: +e.target.value })
                                }
                              />
                              <span className="muted">{noteLabel(r.note)}</span>
                            </div>
                          </td>
                          <td>
                            {mapping === "qwerty"
                              ? (workingProfile.qwerty[i].modifiers ?? [])
                                  .map((m) =>
                                    m === 224
                                      ? "Ctrl + "
                                      : m === 225
                                        ? "Shift + "
                                        : "Mod + ",
                                  )
                                  .join("")
                              : ""}
                            {keyLabel(r.hid)}
                          </td>
                          <td>
                            <input
                              aria-label={`HID for binding ${i + 1}`}
                              type="number"
                              min="4"
                              max="231"
                              value={r.hid}
                              onChange={(e) =>
                                editRow(i, { hid: +e.target.value })
                              }
                            />
                          </td>
                          <td className="row-actions">
                            {mapping === "qwerty" && (
                              <button
                                aria-label={`Learn MIDI note for binding ${i + 1}`}
                                onClick={() => {
                                  learnReceived.current = state.received;
                                  setLearn(learn === i ? null : i);
                                }}
                              >
                                {learn === i ? "Listening…" : "Learn"}
                              </button>
                            )}
                            <button
                              aria-label={`Remove binding ${i + 1}`}
                              onClick={() => removeRow(i)}
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!rows.length && (
                    <div className="empty">
                      No bindings. Add a key or restore the default preset.
                    </div>
                  )}
                </div>
              </section>
              <aside className="secondary-panel">
                <h2>Profile</h2>
                <label className="field">
                  Name
                  <input
                    value={workingProfile.name}
                    maxLength={128}
                    onChange={(e) =>
                      editProfile((p) => (p.name = e.target.value))
                    }
                  />
                </label>
                <div className="button-row">
                  <button
                    onClick={() => {
                      const copy = api.clone(workingProfile);
                      copy.id = `profile-${Date.now()}`;
                      copy.name = `${copy.name} copy`;
                      editSettings((s) => {
                        s.profiles.push(copy);
                        s.selected_profile = copy.id;
                      });
                    }}
                  >
                    Duplicate
                  </button>
                  <button
                    disabled={working.profiles.length <= 1}
                    onClick={() =>
                      editSettings((s) => {
                        s.profiles = s.profiles.filter(
                          (p) => p.id !== s.selected_profile,
                        );
                        s.selected_profile = s.profiles[0].id;
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
                <div className="button-row">
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const path = await api.chooseFile("profile");
                        if (!path) return;
                        const imported = await api.importProfile(path);
                        const next = api.clone(draft ?? stateRef.current.settings);
                        next.profiles.push(imported);
                        next.selected_profile = imported.id;
                        if (!draft) setDraftRevision(stateRef.current.revision);
                        setDraft(next);
                      })
                    }
                  >
                    Import
                  </button>
                  <button
                    disabled={busy || !!draft}
                    onClick={() =>
                      run(async () => {
                        const path = await api.chooseFile("profile", true);
                        if (path) await api.exportFile(path, "profile");
                      })
                    }
                  >
                    Export
                  </button>
                </div>
                <button
                  onClick={() =>
                    editProfile((p) => {
                      const fresh = p.visual_pianos
                        ? api.visualProfile()
                        : api.defaultProfile();
                      p.analog = fresh.analog;
                      p.qwerty = fresh.qwerty;
                    })
                  }
                >
                  Restore default mappings
                </button>
                <div className="control-block game-options">
                  <h2>Game output</h2>
                  <Toggle
                    label="Visual Pianos output"
                    checked={workingProfile.visual_pianos}
                    onChange={(enabled) =>
                      editProfile((p) => (p.visual_pianos = enabled))
                    }
                  />
                  <Toggle
                    label="Velocity"
                    checked={workingProfile.game_velocity}
                    disabled={!workingProfile.visual_pianos}
                    onChange={(enabled) =>
                      editProfile((p) => (p.game_velocity = enabled))
                    }
                  />
                  <Toggle
                    label="Sustain"
                    checked={
                      workingProfile.sustain_enabled &&
                      workingProfile.sustain_hid !== null
                    }
                    onChange={(enabled) =>
                      editProfile((p) => {
                        p.sustain_enabled = enabled;
                        if (enabled) p.sustain_hid ??= 44;
                      })
                    }
                  />
                  <Toggle
                    label="88 Keys"
                    checked={workingProfile.extended_keys}
                    onChange={(enabled) =>
                      editProfile((p) => (p.extended_keys = enabled))
                    }
                  />
                  <button
                    onClick={() =>
                      editProfile((p) => {
                        const preset = api.visualProfile();
                        p.qwerty = preset.qwerty;
                        p.visual_pianos = true;
                        p.game_velocity = true;
                        p.sustain_enabled = true;
                        p.extended_keys = true;
                        p.sustain_hid = 44;
                        p.sostenuto_hid = 48;
                      })
                    }
                  >
                    Load Visual Pianos 88-key output
                  </button>
                  <p className="help">
                    Shift: black notes. Ctrl: extended range. MIDI velocity:
                    Alt + key. Sustain: Space; sostenuto: ].
                  </p>
                </div>
                <div className="aside-bottom">
                  <p className="help">
                    {draft
                      ? "Unsaved draft. Applying releases generated output."
                      : "Focus in an editor pauses generated keys."}
                  </p>
                  <button
                    className="primary"
                    disabled={!draft || busy}
                    onClick={() =>
                      run(() => applySettings(draft!, draftRevision))
                    }
                  >
                    Apply profile
                  </button>
                  <button
                    disabled={!draft}
                    onClick={() => {
                      setDraft(null);
                      setLearn(null);
                    }}
                  >
                    Discard draft
                  </button>
                </div>
              </aside>
            </div>
          </div>
        )}
        {tab === "Sequencer" && (
          <div className="sequencer">
            <div className="section-heading">
              <h1>Sequencer</h1>
              <span className="muted">Four tracks · 16 steps · 4/4</span>
            </div>
            <div className="transport">
              <button
                className={state.playing ? "active" : "primary"}
                disabled={busy}
                onClick={() => send("transport", { action: "play" })}
              >
                ▶ Play
              </button>
              <button
                disabled={busy}
                onClick={() => send("transport", { action: "stop" })}
              >
                ■ Stop
              </button>
              <button
                aria-pressed={state.recording}
                className={state.recording ? "record active" : ""}
                disabled={busy}
                onClick={() => send("transport", { action: "record" })}
              >
                ● Record
              </button>
              <label className="inline-label">
                BPM
                <input
                  aria-label="Tempo BPM"
                  type="number"
                  min="20"
                  max="300"
                  defaultValue={state.project.bpm}
                  key={state.project.bpm}
                  onBlur={(e) => {
                    if (+e.target.value !== state.project.bpm)
                      updateProject((p) => (p.bpm = +e.target.value));
                  }}
                />
              </label>
              <span className="transport-position">
                {String(state.cursor + 1).padStart(2, "0")} / 16
              </span>
              <div className="spacer" />
              <button
                disabled={busy}
                onClick={() => run(() => fileProject(false))}
              >
                Open
              </button>
              <button
                disabled={busy}
                onClick={() => run(() => fileProject(true))}
              >
                Save
              </button>
            </div>
            <div className="project-name">
              <input
                aria-label="Project name"
                maxLength={128}
                key={state.project.name}
                defaultValue={state.project.name}
                onBlur={(e) => {
                  if (e.target.value !== state.project.name)
                    updateProject((p) => (p.name = e.target.value));
                }}
              />
              <span className="muted">
                {state.project_dirty
                  ? "Unsaved changes"
                  : "Project saved / unchanged"}
              </span>
            </div>
            <div className="track-list">
              {state.project.tracks.map((track, t) => (
                <section
                  className={`track ${state.armed_track === t ? "armed" : ""}`}
                  key={t}
                >
                  <div className="track-heading">
                    <button
                      className="arm-button"
                      aria-pressed={state.armed_track === t}
                      aria-label={`Arm track ${t + 1}`}
                      disabled={busy}
                      onClick={() => {
                        send("arm", { track: t });
                        setStepIndex(state.cursor);
                      }}
                    >
                      {state.armed_track === t ? "●" : "○"}
                    </button>
                    <input
                      aria-label={`Track ${t + 1} name`}
                      key={track.name}
                      defaultValue={track.name}
                      onBlur={(e) => {
                        if (e.target.value !== track.name)
                          updateProject(
                            (p) => (p.tracks[t].name = e.target.value),
                          );
                      }}
                    />
                    <Toggle
                      label="Mute"
                      checked={track.muted}
                      onChange={(muted) =>
                        updateProject((p) => (p.tracks[t].muted = muted))
                      }
                      disabled={busy}
                    />
                    <label className="inline-label">
                      Ch
                      <Channel
                        label={`Track ${t + 1} channel`}
                        value={track.channel}
                        onChange={(c) =>
                          updateProject((p) => (p.tracks[t].channel = c!))
                        }
                      />
                    </label>
                    <select
                      aria-label={`Track ${t + 1} output`}
                      value={destinationValue(
                        profile.routes.find(
                          (r) =>
                            r.enabled &&
                            r.source.kind === "sequencer" &&
                            r.source.track === t,
                        )?.destination ?? { kind: "midi", id: "" },
                      ).replace(/^midi:$/, "")}
                      disabled={busy}
                      onChange={(e) => trackRoute(t, e.target.value)}
                    >
                      <option value="">No output</option>
                      <option value="qwerty">
                        QWERTY · toggle required · Ch 1 mapping
                      </option>
                      {state.outputs.map((d) => (
                        <option key={d.id} value={`midi:${d.id}`}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="steps">
                    {track.steps.map((step, i) => (
                      <button
                        key={i}
                        className={`step ${step.notes.length ? "filled" : ""} ${state.playing && state.cursor === i ? "current" : ""} ${state.armed_track === t && stepIndex === i ? "selected" : ""}`}
                        aria-label={`Track ${t + 1} step ${i + 1}, ${step.notes.length} notes`}
                        aria-pressed={
                          state.armed_track === t && stepIndex === i
                        }
                        onClick={() => {
                          if (state.armed_track !== t)
                            send("arm", { track: t });
                          selectStep(i);
                        }}
                      >
                        <span>{i + 1}</span>
                        <small>
                          {step.notes.length
                            ? step.notes.length === 1
                              ? noteLabel(step.notes[0].note)
                              : `${step.notes.length} notes`
                            : "—"}
                        </small>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
            <div className="step-editor">
              <div>
                <h2>
                  Track {state.armed_track + 1} · Step {stepIndex + 1}
                </h2>
                <p className="help">
                  Record while stopped to replace and advance; while playing to
                  overdub. Chords group after 30 ms of quiet, capped at 100 ms.
                </p>
              </div>
              <label className="field notes-field">
                Notes{" "}
                <span className="muted">
                  pitch:velocity, separated by commas
                </span>
                <input
                  aria-label="Step notes"
                  placeholder="60:100, 64:100, 67:100"
                  value={stepText}
                  onChange={(e) => setStepText(e.target.value)}
                />
              </label>
              <label className="field gate-field">
                Gate %
                <input
                  aria-label="Step gate"
                  type="number"
                  min="1"
                  max="100"
                  value={stepGate}
                  onChange={(e) => setStepGate(+e.target.value)}
                />
              </label>
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const notes = stepText.trim()
                      ? stepText.split(",").map((v) => {
                          const [n, vel, ...extra] = v.trim().split(":");
                          if (
                            extra.length ||
                            !/^\d+$/.test(n) ||
                            (vel !== undefined && !/^\d+$/.test(vel))
                          )
                            throw new Error(
                              "Use pitch:velocity pairs, for example 60:100.",
                            );
                          return {
                            note: +n,
                            velocity: vel === undefined ? 100 : +vel,
                          };
                        })
                      : [];
                    const project = api.clone(stateRef.current.project);
                    project.tracks[state.armed_track].steps[stepIndex] = {
                      notes,
                      gate: stepGate / 100,
                    };
                    return api.command({
                      type: "project",
                      project,
                      expected_revision: stateRef.current.revision,
                    });
                  })
                }
              >
                Apply step
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  updateProject(
                    (p) =>
                      (p.tracks[state.armed_track].steps[stepIndex].notes = []),
                  )
                }
              >
                Clear
              </button>
            </div>
            <p className="help">
              Playback is silent until a track output is selected. QWERTY
              playback also requires the Play screen’s MIDI → QWERTY toggle.
            </p>
          </div>
        )}
        {tab === "Settings" && (
          <div className="split settings">
            <section className="primary-panel">
              <div className="section-heading">
                <h1>Settings</h1>
                <span className="muted">
                  Optional hardware, explicit permissions
                </span>
              </div>
              <div className="control-block">
                <h2>Wooting Analog SDK</h2>
                <p className="help">
                  Install SDK 0.9.1 separately using Wooting’s instructions.
                  lazymidi does not bundle or install the SDK.
                </p>
                <a
                  href="https://github.com/WootingKb/wooting-analog-sdk/blob/v0.9.1/docs/INSTALL.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  Official installation instructions ↗
                </a>
                <label className="field">
                  Custom absolute SDK library path
                  <input
                    placeholder="Use official installation location"
                    value={working.sdk_path ?? ""}
                    onChange={(e) =>
                      editSettings((s) => (s.sdk_path = e.target.value || null))
                    }
                  />
                </label>
                <div className="button-row">
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const path = await api.chooseFile("sdk");
                        if (path) editSettings((s) => (s.sdk_path = path));
                      })
                    }
                  >
                    Choose library
                  </button>
                  <button disabled={busy} onClick={() => send("refresh")}>
                    Check installation
                  </button>
                </div>
                <div className="details-row">
                  <span className="muted">Detected library</span>
                  <span className="path">
                    {state.sdk_found ?? "Not installed / not found"}
                  </span>
                </div>
                <label className="field">
                  Analog polling
                  <select
                    value={working.polling_hz}
                    onChange={(e) =>
                      editSettings((s) => (s.polling_hz = +e.target.value))
                    }
                  >
                    {[100, 250, 500, 1000].map((hz) => (
                      <option key={hz} value={hz}>
                        {hz} Hz
                      </option>
                    ))}
                  </select>
                </label>
                <Toggle
                  label="Polyphonic aftertouch"
                  checked={working.aftertouch}
                  onChange={(checked) =>
                    editSettings((s) => (s.aftertouch = checked))
                  }
                />
              </div>
              <div className="control-block">
                <h2>Keyboard output permissions</h2>
                <p>
                  Windows: run the target at the same integrity level. Normal
                  lazymidi cannot send input to elevated applications.
                </p>
                <p>
                  Linux: your user needs access to <code>/dev/uinput</code>.
                  Native Wayland behavior depends on the compositor and target.
                </p>
                <p>
                  macOS: allow lazymidi under Privacy & Security → Accessibility
                  when enabling output.
                </p>
                <p className="help">
                  Permissions are checked when output is enabled. Do not run
                  lazymidi as root. Input Monitoring is not required.
                </p>
              </div>
              <div className="button-row">
                <button
                  className="primary"
                  disabled={!draft || busy}
                  onClick={() =>
                    run(() => applySettings(draft!, draftRevision))
                  }
                >
                  Apply settings
                </button>
                <button disabled={!draft} onClick={() => setDraft(null)}>
                  Discard draft
                </button>
              </div>
            </section>
            <aside className="secondary-panel">
              <h2>Diagnostics</h2>
              <div className="details-row">
                <span className="muted">Version</span>
                <span>0.1.2</span>
              </div>
              <div className="details-row">
                <span className="muted">Events received</span>
                <span>{state.received}</span>
              </div>
              <div className="details-row">
                <span className="muted">Fault recoveries</span>
                <span>{state.dropped}</span>
              </div>
              <div className="details-row">
                <span className="muted">SDK version</span>
                <span>{state.sdk_version ?? "Not loaded"}</span>
              </div>
              <div className="details-row">
                <span className="muted">Output backend</span>
                <span>{state.keyboard_backend}</span>
              </div>
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const path = await api.chooseFile("profile", true);
                    if (path) await api.exportFile(path, "diagnostics");
                  })
                }
              >
                Export diagnostics
              </button>
              <div className="control-block">
                <h2>Startup & recovery</h2>
                <p className="help">
                  Player mode, devices, profiles, and routes are remembered.
                  Analog input and generated keys start off. Invalid settings
                  are preserved; one backup is kept for recovery.
                </p>
                <p className="help">
                  Profiles and projects use version 1 JSON. Unsupported future
                  versions are rejected.
                </p>
              </div>
              <div className="aside-bottom">
                <p className="help">
                  Panic releases owned output and stops both optional modules.
                  Hardware removal, force-kill, and OS failures can prevent
                  delivery of releases.
                </p>
                <button onClick={() => send("panic")}>
                  Release all output
                </button>
              </div>
            </aside>
          </div>
        )}
      </main>
      <footer className="statusbar">
        <Status active={state.qwerty_enabled}>
          {state.qwerty_enabled
            ? state.paused
              ? "Generated keys paused"
              : "QWERTY output enabled"
            : "QWERTY output off"}
        </Status>
        <span>
          {draft
            ? "Profile draft unsaved"
            : state.recording
              ? `Recording · Track ${state.armed_track + 1}`
              : state.playing
                ? "Playing"
                : "Ready"}
        </span>
        <span className="spacer" />
        <span>lazymidi 0.1.2 {api.desktop ? "" : "· browser preview"}</span>
      </footer>
    </div>
  );
}

function Routes({
  routes,
  outputs,
  edit,
  add,
}: {
  routes: Route[];
  outputs: api.Device[];
  edit: (change: (routes: Route[]) => void) => void;
  add: () => void;
}) {
  return (
    <>
      <div className="route-list">
        {routes.map((r, i) => (
          <div className="route" key={r.id}>
            <input
              aria-label={`Enable route ${i + 1}`}
              type="checkbox"
              checked={r.enabled}
              onChange={(e) => edit((rs) => (rs[i].enabled = e.target.checked))}
            />
            <select
              aria-label={`Route ${i + 1} source`}
              value={sourceValue(r.source)}
              onChange={(e) =>
                edit((rs) => (rs[i].source = sourceFrom(e.target.value)))
              }
            >
              <option value="midi">MIDI input</option>
              <option value="analog">Analog input</option>
              {[0, 1, 2, 3].map((t) => (
                <option key={t} value={`track:${t}`}>
                  Track {t + 1}
                </option>
              ))}
            </select>
            <span aria-hidden="true">→</span>
            <select
              aria-label={`Route ${i + 1} destination`}
              value={destinationValue(r.destination)}
              onChange={(e) =>
                edit(
                  (rs) => (rs[i].destination = destinationFrom(e.target.value)),
                )
              }
            >
              <option value="qwerty">QWERTY</option>
              {outputs.map((d) => (
                <option key={d.id} value={`midi:${d.id}`}>
                  {d.name}
                </option>
              ))}
              {[0, 1, 2, 3].map((t) => (
                <option key={t} value={`recorder:${t}`}>
                  Recorder {t + 1}
                </option>
              ))}
            </select>
            <Channel
              all
              label={`Route ${i + 1} input channel`}
              value={r.channel}
              onChange={(c) => edit((rs) => (rs[i].channel = c))}
            />
            <Channel
              all
              label={`Route ${i + 1} output channel`}
              value={r.remap_channel}
              onChange={(c) => edit((rs) => (rs[i].remap_channel = c))}
            />
            <button
              aria-label={`Remove route ${i + 1}`}
              onClick={() => edit((rs) => rs.splice(i, 1))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button onClick={add}>Add route</button>
    </>
  );
}
