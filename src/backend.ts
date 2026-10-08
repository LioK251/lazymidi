import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";
import visualBindings from "../crates/lazymidi-core/resources/presets/visual-pianos-qwerty.json";
import analogDefault from "../crates/lazymidi-core/resources/presets/default-analog.json";

export type Source =
  { kind: "midi" | "analog" } | { kind: "sequencer"; track: number };
export type Destination =
  | { kind: "qwerty" }
  | { kind: "midi"; id: string }
  | { kind: "recorder"; id: number };
// Rust's adjacent-tagged Source/Destination serialize their payload under `track`/`id`.
export interface Route {
  id: string;
  source: Source;
  destination: Destination;
  enabled: boolean;
  channel: number | null;
  remap_channel: number | null;
}
export interface AnalogPreset {
  keymapping: Record<string, [number, number][]>;
  shift_amount: number;
  note_config: { threshold: number; velocity_scale: number };
}
export interface Binding {
  channel: number;
  note: number;
  hid: number;
  modifiers?: number[];
}
export interface Profile {
  id: string;
  name: string;
  analog: AnalogPreset;
  qwerty: Binding[];
  routes: Route[];
  visual_pianos: boolean;
  game_velocity: boolean;
  sustain_hid: number | null;
  sostenuto_hid: number | null;
}
export interface Settings {
  version: number;
  selected_profile: string;
  profiles: Profile[];
  input_mode: "analog" | "midi";
  preferred_midi: string | null;
  sdk_path: string | null;
  analog_device: string | null;
  polling_hz: number;
  aftertouch: boolean;
  both_inputs: boolean;
}
export interface Step {
  notes: { note: number; velocity: number }[];
  gate: number;
}
export interface Project {
  version: number;
  name: string;
  bpm: number;
  tracks: { name: string; channel: number; muted: boolean; steps: Step[] }[];
}
export interface Device {
  id: string;
  name: string;
}
export interface Snapshot {
  native_smoke?: boolean;
  revision: number;
  settings: Settings;
  inputs: Device[];
  outputs: Device[];
  midi_connected: string | null;
  analog_devices: Device[];
  analog_connected: string | null;
  sdk_found: string | null;
  sdk_version: string | null;
  analog_enabled: boolean;
  analog_pending: boolean;
  qwerty_enabled: boolean;
  qwerty_pending: boolean;
  paused: boolean;
  keyboard_backend: string;
  warning: string | null;
  error: string | null;
  received: number;
  dropped: number;
  active_notes: [Source, number, number][];
  last_event: { status: number; data1: number; data2: number } | null;
  project: Project;
  project_dirty: boolean;
  playing: boolean;
  recording: boolean;
  armed_track: number;
  cursor: number;
}
export const desktop = isTauri();
export const clone = <T>(value: T): T => structuredClone(value);
export function defaultProfile(): Profile {
  const analog: AnalogPreset = {
    ...clone(analogDefault),
    keymapping: Object.fromEntries(
      Object.entries(analogDefault.keymapping).map(([channel, pairs]) => [
        channel,
        pairs.map(([hid, note]): [number, number] => [hid, note]),
      ]),
    ),
  };
  return {
    id: "default-copy",
    name: "Default copy",
    analog,
    qwerty: Object.entries(analog.keymapping).flatMap(([channel, pairs]) =>
      pairs.map(([hid, note]) => ({ channel: +channel, hid, note })),
    ),
    visual_pianos: false,
    game_velocity: false,
    sustain_hid: null,
    sostenuto_hid: null,
    routes: ["midi", "analog"].map((kind) => ({
      id: `live-${kind}`,
      source: { kind } as Source,
      destination: { kind: "qwerty" },
      enabled: true,
      channel: null,
      remap_channel: null,
    })),
  };
}
export function visualProfile(): Profile {
  return {
    ...defaultProfile(),
    id: "visual-pianos",
    name: "Visual Pianos · 88 keys",
    qwerty: clone(visualBindings),
    visual_pianos: true,
    game_velocity: true,
    sustain_hid: 44,
    sostenuto_hid: 48,
  };
}
export function initialState(): Snapshot {
  return {
    revision: 0,
    settings: {
      version: 1,
      selected_profile: "visual-pianos",
      profiles: [defaultProfile(), visualProfile()],
      input_mode: "analog",
      preferred_midi: null,
      sdk_path: null,
      analog_device: null,
      polling_hz: 250,
      aftertouch: true,
      both_inputs: false,
    },
    inputs: [],
    outputs: [],
    midi_connected: null,
    analog_devices: [],
    analog_connected: null,
    sdk_found: null,
    sdk_version: null,
    analog_enabled: false,
    analog_pending: false,
    qwerty_enabled: false,
    qwerty_pending: false,
    paused: false,
    keyboard_backend: "Desktop app required",
    warning:
      "Browser preview · native MIDI and keyboard output are unavailable.",
    error: null,
    received: 0,
    dropped: 0,
    active_notes: [],
    last_event: null,
    project: {
      version: 1,
      name: "Untitled",
      bpm: 120,
      tracks: Array.from({ length: 4 }, (_, i) => ({
        name: `Track ${i + 1}`,
        channel: i,
        muted: false,
        steps: Array.from({ length: 16 }, () => ({ notes: [], gate: 0.8 })),
      })),
    },
    project_dirty: false,
    playing: false,
    recording: false,
    armed_track: 0,
    cursor: 0,
  };
}
type Command = { type: string; [key: string]: unknown };
let preview = initialState();
export async function getState(): Promise<Snapshot> {
  return desktop ? invoke("get_state") : clone(preview);
}
export async function nativeSmokeReady(enabled: boolean): Promise<void> {
  if (desktop && enabled)
    await invoke("native_smoke_ready");
}
export async function subscribe(
  fn: (snapshot: Snapshot) => void,
): Promise<() => void> {
  if (!desktop) return () => {};
  return listen<Snapshot>("state", (event) => fn(event.payload));
}
export async function command(command: Command): Promise<Snapshot> {
  if (desktop) return invoke("app_command", { command });
  switch (command.type) {
    case "settings":
      preview.settings = clone(command.settings as Settings);
      preview.revision++;
      preview.qwerty_enabled = false;
      break;
    case "project":
      preview.project = clone(command.project as Project);
      preview.project_dirty = true;
      preview.revision++;
      break;
    case "arm":
      preview.armed_track = command.track as number;
      break;
    case "cursor":
      preview.cursor = command.step as number;
      break;
    case "pause":
      preview.paused = command.paused as boolean;
      break;
    case "panic":
      preview.playing = false;
      preview.recording = false;
      preview.qwerty_enabled = false;
      break;
    case "transport":
      if (command.action === "play") preview.playing = true;
      if (command.action === "stop") {
        preview.playing = false;
        preview.recording = false;
      }
      if (command.action === "record") preview.recording = !preview.recording;
      break;
    case "qwerty":
      if (command.enabled)
        throw new Error(
          "Open the desktop app and connect an input before enabling keyboard output.",
        );
      break;
    case "analog":
      if (command.enabled)
        throw new Error(
          "Analog input requires the desktop app and an installed Wooting SDK.",
        );
      break;
  }
  return clone(preview);
}
export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String(error.message)
      : String(error);
}
export async function chooseFile(
  kind: "profile" | "project" | "sdk",
  writing = false,
): Promise<string | null> {
  if (!desktop)
    throw new Error("File dialogs are available in the desktop app.");
  const filters =
    kind === "sdk"
      ? [{ name: "SDK library", extensions: ["dll", "so", "dylib"] }]
      : [
          {
            name: kind === "project" ? "lazymidi project" : "JSON profile",
            extensions: kind === "project" ? ["lazymidi"] : ["json"],
          },
        ];
  return whilePaused(async () => {
    if (writing)
      return save({
        filters,
        defaultPath: kind === "project" ? "Untitled.lazymidi" : "profile.json",
      });
    const result = await open({ filters, multiple: false, directory: false });
    return typeof result === "string" ? result : null;
  });
}
export async function importProfile(path: string): Promise<Profile> {
  return invoke("import_file", { path });
}
export async function exportFile(path: string, kind: string): Promise<void> {
  return invoke("export_file", { path, kind });
}
export async function projectFile(
  path: string,
  writing: boolean,
): Promise<Snapshot> {
  return invoke(writing ? "save_project" : "load_project", { path });
}
export async function ask(message: string): Promise<boolean> {
  return desktop
    ? whilePaused(() => confirm(message, { title: "lazymidi", kind: "warning" }))
    : window.confirm(message);
}
async function whilePaused<T>(action: () => Promise<T>): Promise<T> {
  const wasPaused = (await getState()).paused;
  if (!wasPaused) await command({ type: "pause", paused: true });
  try {
    return await action();
  } finally {
    if (!wasPaused) await command({ type: "pause", paused: false });
  }
}
export async function closeApp(dirty: boolean): Promise<void> {
  if (!desktop) return;
  await command({ type: "panic" });
  if (dirty && !(await ask("Discard unsaved project changes and close?")))
    return;
  await invoke("shutdown");
}
