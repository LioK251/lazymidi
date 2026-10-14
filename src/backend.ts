import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";
import visualBindings from "../crates/lazymidi-core/resources/presets/visual-pianos-qwerty.json";
import analogDefault from "../crates/lazymidi-core/resources/presets/default-analog.json";
import { createPauseController } from "./pause";

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
export interface TransposeConfig { sequence: number[]; up: number | null; down: number | null; next_shortcut: string | null; previous_shortcut: string | null; pause_shortcut: string | null }
export interface TransposeStatus { current: number | null; selected: number; armed: boolean; busy: boolean; target: number | null; completed: number; total: number; editing: boolean; error: string | null }
export const defaultTranspose = (): TransposeConfig => ({sequence:[0],up:null,down:null,next_shortcut:null,previous_shortcut:null,pause_shortcut:null});
export interface Profile {
  id: string;
  name: string;
  analog: AnalogPreset;
  qwerty: Binding[];
  routes: Route[];
  visual_pianos: boolean;
  game_velocity: boolean;
  sustain_enabled: boolean;
  extended_keys: boolean;
  sustain_hid: number | null;
  sostenuto_hid: number | null;
  transpose: TransposeConfig;
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
  discord_presence: boolean;
  discord_get_button: boolean;
  show_transposer: boolean;
  show_converter: boolean;
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
  native_smoke_overlays?: boolean;
  native_smoke_converter?: boolean;
  presence: string;
  transpose: TransposeStatus;
  state_sequence: number;
  latency?: Record<string, { count: number; samples: number; p50_us: number; p95_us: number; p99_us: number; max_us: number }> | null;
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
    sustain_enabled: false,
    extended_keys: true,
    sustain_hid: null,
    sostenuto_hid: null,
    transpose: defaultTranspose(),
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
    sustain_enabled: true,
    sustain_hid: 44,
    sostenuto_hid: 48,
  };
}
export function initialState(): Snapshot {
  return {
    presence: "Desktop app required",
    transpose: { current:0, selected:0, armed:false, busy:false, target:null, completed:0,total:0,editing:false,error:null },
    state_sequence: 0,
    revision: 0,
    settings: {
      version: 1,
      selected_profile: "visual-pianos",
      profiles: [defaultProfile(), visualProfile()],
      input_mode: "analog",
      preferred_midi: null,
      sdk_path: null,
      analog_device: null,
      polling_hz: 1000,
      aftertouch: true,
      both_inputs: false,
      discord_presence: true,
      discord_get_button: true,
      show_transposer: true,
      show_converter: false,
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
export async function nativeSmokeReady(enabled: boolean, overlays = false, converter = false): Promise<void> {
  if (desktop && enabled) {
    if (overlays) {
      await openOverlay("monitor");
      const {WebviewWindow}=await import("@tauri-apps/api/webviewWindow");
      const monitor=await WebviewWindow.getByLabel("monitor");
      if(!monitor)throw new Error("Transpose monitor did not open.");
      const size=(await monitor.innerSize()).toLogical(await monitor.scaleFactor());
      if(size.width>261||size.height>131)throw new Error("Transpose monitor did not restore compact geometry.");
      await openOverlay("sheet");
      const sheet=await WebviewWindow.getByLabel("sheet");
      if(!sheet)throw new Error("Sheet window did not open.");
      await sheet.minimize();
      for(let wait=0;wait<40&&!await sheet.isMinimized();wait++)await new Promise(resolve=>setTimeout(resolve,25));
      if(!await sheet.isMinimized())throw new Error("Sheet window did not minimize.");
      await openOverlay("sheet");
      for(let wait=0;wait<40&&await sheet.isMinimized();wait++)await new Promise(resolve=>setTimeout(resolve,25));
      if(await sheet.isMinimized()||!await sheet.isVisible())throw new Error("Sheet window did not restore after minimizing.");
    }
    if (converter) {
      await invoke("converter_request",{method:"GET",path:"/api/health",body:null});
      await invoke("converter_request",{method:"GET",path:"/api/midi-files",body:null});
      const {convertFileSrc}=await import("@tauri-apps/api/core");
      const response=await fetch(convertFileSrc("converted/smoke.mid","converter"));
      if(!response.ok||new TextDecoder().decode((await response.arrayBuffer()).slice(0,4))!=="MThd")
        throw new Error("Native MIDI preview could not read its scoped asset.");
      const appearance=await invoke<{visualizer_scenes?:Record<string,{media_url?:string}>}>("converter_request",{method:"GET",path:"/api/settings",body:null});
      const background=appearance.visualizer_scenes?.sketch?.media_url;
      if(!background)throw new Error("Native background import fixture is missing.");
      const image=new Image();image.crossOrigin="anonymous";image.src=convertFileSrc(background,"converter");
      await image.decode();
      if(image.naturalWidth!==8||image.naturalHeight!==8)throw new Error("Native imported background could not decode.");
      const sheet=await invoke<{revision:number;text:string}>("generate_sheet",{midiFilename:"smoke.mid",settings:{transpose_mode:"manual",manual_transpose_points:[{chord:0,value:-3}]},expectedRevision:null});
      if(!sheet.text.includes("Transpose by: 3"))throw new Error("Native sheet generation failed.");
      let rejected=false;try{await invoke("generate_sheet",{midiFilename:"smoke.mid",settings:{},expectedRevision:sheet.revision-1});}catch{rejected=true;}
      if(!rejected)throw new Error("Stale sheet generation was accepted.");
      const fonts=await invoke<{soundfonts:{filename:string;size:number}[]}>("converter_request",{method:"GET",path:"/api/soundfonts",body:null});
      for(const font of fonts.soundfonts.filter(f=>f.size>64*1024*1024)){
        const url=convertFileSrc(`soundfonts/${font.filename}`,"converter");
        const chunk=await fetch(url,{headers:{Range:"bytes=0-1023"}});
        if(chunk.status!==206||(await chunk.arrayBuffer()).byteLength!==1024)throw new Error("Native SoundFont ranges failed.");
        let accepted=false;try{accepted=(await fetch(url)).ok;}catch{/* Large unbounded responses must fail safely. */}
        if(accepted)throw new Error("Unbounded SoundFont delivery was accepted.");
      }
      let finish:(value:boolean)=>void=()=>{};let timer:ReturnType<typeof setTimeout>|undefined;
      const stop=await listen<{filename:string;loaded:boolean}>("visualizer-ready",e=>{if(e.payload.filename==="smoke.mid")finish(e.payload.loaded);});
      try{
        const {WebviewWindow}=await import("@tauri-apps/api/webviewWindow");
        for(let attempt=0;attempt<3;attempt++){
          const loaded=new Promise<boolean>(resolve=>{finish=resolve;timer=setTimeout(()=>resolve(false),15000);});
          await invoke("open_visualizer",{midiFilename:"smoke.mid"});
          if(!await loaded)throw new Error("Native piano preview did not finish loading.");
          clearTimeout(timer);
          if(attempt===1){
            const cached=await WebviewWindow.getByLabel("visualizer");
            await cached?.close();
            for(let wait=0;wait<40&&await cached?.isVisible();wait++)await new Promise(resolve=>setTimeout(resolve,25));
            if(!await WebviewWindow.getByLabel("visualizer")||await cached?.isVisible())throw new Error("Visualizer was not retained hidden.");
          }
        }
      }finally{stop();clearTimeout(timer);}
    }
    await invoke("native_smoke_ready");
  }
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
    case "settings": {
      const before=clone(preview.settings);
      const after=clone(command.settings as Settings);
      const normalized=(s:Settings)=>({...s,discord_presence:false,discord_get_button:false,show_transposer:false,show_converter:false,profiles:s.profiles.map(p=>({...p,transpose:defaultTranspose()}))});
      if (JSON.stringify(normalized(before))!==JSON.stringify(normalized(after))) preview.qwerty_enabled=false;
      preview.settings = clone(command.settings as Settings);
      preview.revision++;
      break; }
    case "transpose_editing": preview.transpose.editing=!!command.editing; break;
    case "transpose":
      if(command.action==="sync") {preview.transpose.current=Number(command.value);preview.transpose.armed=false;}
      if(command.action==="select") preview.transpose.selected=Number(command.index);
      if(command.action==="arm" || command.action==="toggle") throw new Error("Transpose output requires the desktop app.");
      if(command.action==="pause") preview.transpose.armed=false;
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
      preview.transpose.editing = command.paused as boolean;
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
  preview.state_sequence++;
  return clone(preview);
}
export const pauseOutput = createPauseController((paused: boolean) =>
  command({ type: "pause", paused }),
);
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
export async function whilePaused<T>(action: () => Promise<T>): Promise<T> {
  const reason = Symbol("dialog");
  try {
    await pauseOutput(reason, true);
    return await action();
  } finally {
    await pauseOutput(reason, false);
  }
}
export async function closeApp(dirty: boolean): Promise<void> {
  if (!desktop) return;
  await command({ type: "panic" });
  if (dirty && !(await ask("Discard unsaved project changes and close?")))
    return;
  await invoke("shutdown");
}

export async function openOverlay(kind: "monitor" | "sheet"): Promise<void> {
  if(!desktop)return;
  await invoke("open_overlay",{kind});
  if(kind==="monitor"){
    const state=await getState();const config=state.settings.profiles.find(p=>p.id===state.settings.selected_profile)!.transpose;
    if(!state.transpose.armed&&config.up!==null&&config.down!==null)
      await command({type:"transpose",action:"arm"});
  }
}

export async function sendTransposeSequence(sequence:number[]):Promise<Snapshot> {
  if(!sequence.length||sequence.length>512||sequence.some(n=>!Number.isInteger(n)||n < -50||n > 50))
    throw new Error("Transpose sequence needs 1–512 whole numbers between −50 and 50.");
  const state=await getState();const settings=clone(state.settings);
  if(state.transpose.busy)throw new Error("Wait for the current transpose to finish before replacing its sequence.");
  settings.profiles.find(p=>p.id===settings.selected_profile)!.transpose.sequence=[...sequence];
  const saved=await command({type:"settings",settings,expected_revision:state.revision});
  if(!settings.show_transposer)return saved;
  await command({type:"transpose",action:"pause"});
  const selected=await command({type:"transpose",action:"select",index:0});
  const config=selected.settings.profiles.find(p=>p.id===selected.settings.selected_profile)!.transpose;
  if(config.up===null||config.down===null)return selected;
  return command({type:"transpose",action:"arm"});
}
