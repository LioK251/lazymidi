import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import * as api from "./backend";
import {SongPreview} from "./ConverterPreviews";
import {SheetText,SheetTools} from "./SheetText";

import {listen} from "@tauri-apps/api/event";
import {converterRequest,defaults,transposeModes,gamePoints,visualizerSetting} from "./converter-api";
import type {Values,SheetContent} from "./converter-api";
type Pack={variant:string;version:string;bytes:number;installed_bytes:number;url:string|null;parts?:{url:string|null}[]};
type ExistingEnvironment={python:string;python_version:string;torch_version:string;cuda_available:boolean;cuda_error:string|null};
type RuntimeStatus={status:{installed:string|null;running:boolean;installing:boolean;validating?:boolean;environment?:ExistingEnvironment|null;received:number;total:number;error:string|null};packs:Pack[]};
type MidiFile={filename:string;video_title:string;time_str:string;file_size:number;source_type:string;thumbnail_url?:string};
type History={midi_name:string;video_title:string;timestamp:number;type:string};
type Job={status:string;progress?:string;error?:string;midi_name?:string};
const transposeHelp={auto:"One transpose value for the whole song.",multi:"Automatic transpose changes between regions.",manual:"Set game transpose values at chord positions.",none:"Keep the MIDI’s original pitches."};
const size=(n:number)=>n<1024**2?`${Math.max(1,Math.round(n/1024))} KB`:n<1024**3?`${(n/1024**2).toFixed(1)} MB`:`${(n/1024**3).toFixed(2)} GB`;
const dialog=<T,>(command:string,args:Record<string,unknown>)=>api.whilePaused(()=>invoke<T>(command,args));

export default function Converter({active,onError}:{active:boolean;onError:(message:string)=>void}) {
  const [section,setSection]=useState("Convert");const [runtime,setRuntime]=useState<RuntimeStatus|null>(null);
  const [files,setFiles]=useState<MidiFile[]>([]);const [history,setHistory]=useState<History[]>([]);
  const [selected,setSelected]=useState("");const [search,setSearch]=useState("");
  const [page,setPage]=useState(0);
  const [url,setUrl]=useState("");
  const [jobId,setJobId]=useState<string|null>(null);const [job,setJob]=useState<Job|null>(null);
  const [settings,setSettings]=useState<Values>(defaults);
  const device=settings.compute_device==="cuda"&&runtime?.status.installed==="cuda"?"cuda":"cpu";
  const [sheet,setSheet]=useState("");const [sheetId,setSheetId]=useState("");const [lineMap,setLineMap]=useState<number[]>([]);
  const [sheetColors,setSheetColors]=useState(true);const [sheetZoom,setSheetZoom]=useState(1);
  const [source,setSource]=useState("file");
  const [points,setPoints]=useState("[]");const [transpose,setTranspose]=useState(0);
  const [pointChord,setPointChord]=useState(0);
  const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");
  const [ready,setReady]=useState(false);const [loadError,setLoadError]=useState("");
  const [retry,setRetry]=useState(0);const pending=useRef(0);
  const [pairing,setPairing]=useState<{code:string;expires_seconds:number;endpoint:string}|null>(null);
  const sheetRevision=useRef(0);const generation=useRef(0);
  async function run<T>(action:()=>Promise<T>):Promise<T|undefined>{pending.current++;setBusy(true);try{return await action();}catch(e){onError(api.errorText(e));}finally{setBusy(--pending.current>0);}}
  async function refresh(){const [library,h]=await Promise.all([converterRequest<{midi_files:MidiFile[]}>("/api/midi-files"),converterRequest<History[]>("/api/history?limit=10000")]);setFiles(library.midi_files);setHistory(h);}
  useEffect(()=>{let disposed=false;let timer:ReturnType<typeof setTimeout>;async function update(){try{if(api.desktop){const s=await invoke<RuntimeStatus>("converter_status");if(!disposed)setRuntime(s);}}catch(e){if(!disposed)onError(api.errorText(e));}finally{if(!disposed)timer=setTimeout(()=>void update(),1000);}}void update();return()=>{disposed=true;clearTimeout(timer);};},[]);
  useEffect(()=>{
    let disposed=false;
    setReady(false);setLoadError("");
    if(runtime?.status.installed&&!runtime.status.installing&&!runtime.status.validating)void run(async()=>{
      try {
        await converterRequest("/api/health");
        const [library,h,saved]=await Promise.all([converterRequest<{midi_files:MidiFile[]}>("/api/midi-files"),converterRequest<History[]>("/api/history?limit=10000"),converterRequest<Values>("/api/settings")]);
        if(disposed)return;
        const mode=Object.hasOwn(transposeModes,String(saved.transpose_mode))?saved.transpose_mode:saved.auto_transpose===false?"none":saved.multi_transpose?"multi":"auto";
        setFiles(library.midi_files);setHistory(h);setSettings({...defaults,...saved,transpose_mode:mode});
        // Saved values shift MIDI pitches; the editor shows the opposite game transpose.
        setPoints(JSON.stringify(gamePoints(saved)));setReady(true);
      }catch(e){if(!disposed)setLoadError(api.errorText(e));}
    });
    return()=>{disposed=true;};
  },[runtime?.status.installed,runtime?.status.installing,runtime?.status.validating,runtime?.status.environment?.python,retry]);
  useEffect(()=>{if(!ready||!active)return;const update=()=>void run(refresh);window.addEventListener("focus",update);update();return()=>window.removeEventListener("focus",update);},[ready,active]);
  const selectedRef=useRef(selected);selectedRef.current=selected;
  function chooseMidi(filename:string){selectedRef.current=filename;generation.current++;setSelected(filename);setSheet("");setSheetId("");setLineMap([]);}
  useEffect(()=>{if(!jobId)return;let disposed=false;let timer:ReturnType<typeof setTimeout>;async function poll(){try{const s=await converterRequest<Job>(`/api/status/${jobId}`);if(disposed)return;setJob(s);if(["completed","error","cancelled"].includes(s.status)){setJobId(null);await refresh();if(s.midi_name)chooseMidi(s.midi_name);return;}}catch(e){if(!disposed)onError(api.errorText(e));}if(!disposed)timer=setTimeout(()=>void poll(),500);}void poll();return()=>{disposed=true;clearTimeout(timer);};},[jobId]);
  function acceptSheet(value:SheetContent){
    if(value.source?.midi_filename!==selectedRef.current||(value.revision??0)<=sheetRevision.current)return;
    sheetRevision.current=value.revision??0;setSheet(value.text??"");setSheetId(value.sheets_filename??"");setLineMap(value.source.line_chord_map);
    setSettings(s=>({...s,...value.source!.settings,always_open_float:s.always_open_float,compute_device:s.compute_device}));setPoints(JSON.stringify(gamePoints(value.source.settings)));
  }
  useEffect(()=>{let disposed=false;let stop=()=>{};void listen<SheetContent>("sheet-content",e=>{if(!disposed)acceptSheet(e.payload);}).then(f=>{if(disposed)f();else stop=f;});return()=>{disposed=true;stop();};},[]);
  const openVisualizer=(filename:string)=>run(()=>invoke("open_visualizer",{midiFilename:filename}));
  async function upload(kind:string){const result=await dialog<{task_id?:string;midi_filename?:string;copied?:number;midis?:number;history?:number;skipped?:number}|null>("converter_pick",{kind,device});if(!result)return;if(result.task_id){setJobId(result.task_id);setJob({status:"queued"});}if(result.midi_filename){chooseMidi(result.midi_filename);setSection("Library");setMessage("MIDI imported.");}if(result.copied!==undefined){setSection("Library");setMessage(`Imported ${result.midis??0} MIDI files and ${result.history??0} history entries · ${result.copied} files copied${result.skipped?` · ${result.skipped} already present`:""}.`);}await refresh();}
  const importLibrary=()=>run(()=>upload("import"));
  function setting(key:string,value:unknown){setSettings(s=>({...s,[key]:value}));}
  async function savePreference(key:"always_open_float"|"compute_device",value:boolean|string){
    const latest=await converterRequest<Values>("/api/settings");
    await converterRequest("/api/settings",{...latest,[key]:value});
    setting(key,value);
  }
  function manualPoints(){const value=JSON.parse(points) as {chord:number;value:number}[];if(!Array.isArray(value)||value.some(p=>!p||!Number.isInteger(p.chord)||p.chord<0||!Number.isInteger(p.value)||p.value < -50||p.value>50))throw new Error("Manual points need a chord index and value from −50 to 50.");return value;}
  function sheetSettings(overrides:Values={}){return {...settings,...overrides,manual_transpose_points:manualPoints().map(p=>({...p,value:-p.value}))};}
  async function saveSettings(){const saved=sheetSettings();const latest=await converterRequest<Values>("/api/settings");await converterRequest("/api/settings",{...latest,...Object.fromEntries(Object.entries(saved).filter(([key])=>!visualizerSetting(key)))});setSettings(saved);setMessage("Converter settings saved.");}
  async function generateSheet(overrides:Values={},filename=selected){
    const request=++generation.current;
    try{const value=await invoke<SheetContent>("generate_sheet",{midiFilename:filename,settings:sheetSettings(overrides),expectedRevision:null});
      if(request===generation.current)acceptSheet(value);
    }catch(e){if(request===generation.current&&selectedRef.current===filename)throw e;}
  }
  function openSheet(filename:string){chooseMidi(filename);void run(async()=>{
    if(settings.always_open_float)await api.openOverlay("sheet");
    else{
      const viewer=api.desktop?await (await import("@tauri-apps/api/webviewWindow")).WebviewWindow.getByLabel("sheet"):null;
      if(selectedRef.current!==filename)return;
      if(viewer&&(await viewer.isVisible()||await viewer.isMinimized()))await api.openOverlay("sheet");
      else setSection("Sheets");
    }
    if(selectedRef.current!==filename)return;
    await generateSheet({},filename);
  });}
  function sheetOption(key:string,value:unknown){setting(key,value);if(sheet&&ready&&!busy)void run(()=>generateSheet({[key]:value}));}
  const installed=!!runtime?.status.installed;
  const setupBusy=!!(runtime?.status.installing||runtime?.status.validating);
  const useEnvironment=()=>run(()=>dialog("converter_use_environment",{}));
  const matchingFiles=files.filter(f=>`${f.filename} ${f.video_title} ${f.source_type}`.toLowerCase().includes(search.toLowerCase()));
  const pages=Math.max(1,Math.ceil(matchingFiles.length/24));const currentPage=Math.min(page,pages-1);
  useEffect(()=>setPage(0),[search,files]);
  let displayedPoints:{chord:number;value:number}[]=[];
  try{displayedPoints=manualPoints();}catch{/* Invalid JSON remains editable and is rejected on Generate/Save. */}
  const exportFile=(id:string)=>run(()=>dialog("converter_export",{id}));
  return <div className="converter-panel" data-midi-typing>
    <div className="section-heading"><h1>Converter</h1><span className="muted">{ready?"Ready":loadError?"Needs attention":!api.desktop?"Desktop preview":!runtime?"Checking setup…":installed?"Starting converter…":"Setup required"}</span></div>
    <nav className="segmented" aria-label="Converter sections">{["Convert","Library","Sheets"].map(name=><button key={name} aria-pressed={section===name} onClick={()=>setSection(name)}>{name}</button>)}</nav>
    <p className="converter-intro">{{Convert:"Turn piano audio into MIDI, then make a sheet or preview the notes.",Library:"Your converted and imported MIDI. Choose a song to preview or make a sheet.",Sheets:"Turn MIDI notes into a Virtual Piano sheet."}[section]}</p>
    {!api.desktop&&<p className="notice">Conversion and file imports work in the desktop app.</p>}
    {loadError&&<div className="notice error" role="alert"><strong>Could not start the converter.</strong><p>{loadError}</p><button disabled={busy} onClick={()=>setRetry(n=>n+1)}>Retry startup</button></div>}
    {runtime?.status.validating?<p role="status">Checking Python, Transkun model, FFmpeg and CUDA… <button onClick={()=>void invoke("converter_stop")}>Cancel check</button></p>:installed&&!ready&&!loadError&&<p role="status">Starting converter… Musical input stays available.</p>}
    {(!installed||runtime?.status.installing)&&section==="Convert"&&<section className="converter-setup">
      <h2>1. Set up the converter once</h2><p className="help">Already use mp3converter? Reuse its Python environment, model and FFmpeg without downloading another runtime.</p>
      <button className="primary" disabled={!api.desktop||busy||setupBusy||!!jobId} onClick={()=>void useEnvironment()}>Use existing converter environment</button><p className="help">Choose your old converter folder or its .cuda-venv/.venv folder. Your old app and files stay untouched.</p>
      <details className="converter-advanced"><summary>Or install a separate runtime pack</summary>
      <div className="runtime-choices">{runtime?.packs.map(pack=><div key={pack.variant} className="runtime-choice"><h3>{pack.variant==="cpu"?"CPU · Recommended":"NVIDIA GPU"}</h3><p>{pack.variant==="cpu"?"No dedicated graphics card needed.":"Needs a compatible NVIDIA graphics card."}</p><small>{size(pack.bytes)} download · {size(pack.installed_bytes)} on disk</small><button disabled={busy||setupBusy||!(pack.parts?.length?pack.parts.every(p=>p.url):pack.url)} onClick={()=>void run(()=>dialog("converter_install",{variant:pack.variant,local:false}))}>Download {pack.variant.toUpperCase()}</button></div>)}</div>
      {runtime&&runtime.packs.every(p=>!p.url&&!p.parts?.some(part=>part.url))&&<p className="help">Online packs are not published yet. Have a local pack? Choose its .json file beside the matching .zip.</p>}
      <div className="button-row"><button className="primary" disabled={!api.desktop||busy||setupBusy} onClick={()=>void run(()=>dialog("converter_install",{variant:"cpu",local:true}))}>Install local pack</button>{runtime?.status.installing&&<button onClick={()=>void invoke("converter_stop")}>Cancel install</button>}</div>
      {runtime?.status.installing&&<p role="status">Installing · {size(runtime.status.received)} / {size(runtime.status.total)}</p>}
      </details>
    </section>}
    {installed&&section==="Convert"&&<details className="converter-advanced"><summary>{runtime.status.environment?`Using existing Python ${runtime.status.environment.python_version} · ${runtime.status.environment.cuda_available?"NVIDIA CUDA ready":"CPU"}`:"Installed converter runtime"}</summary>{runtime.status.environment&&<><p className="help">PyTorch {runtime.status.environment.torch_version}<br/>{runtime.status.environment.python}</p>{runtime.status.environment.cuda_error&&<p className="notice">{runtime.status.environment.cuda_error} CPU remains available.</p>}</>}<button disabled={!api.desktop||busy||setupBusy||!!jobId} onClick={()=>void useEnvironment()}>Use existing converter environment</button></details>}
    {!installed&&section!=="Convert"&&<p className="help">Install a runtime in Convert to use your MIDI files here.</p>}
      {section==="Convert"&&<div className="split converter-workflow"><section className="primary-panel"><h2>Convert piano audio</h2>
        <div className="segmented converter-source" role="group" aria-label="Conversion source"><button aria-pressed={source==="file"} onClick={()=>setSource("file")}>Local file</button><button aria-pressed={source==="link"} onClick={()=>setSource("link")}>Media link</button></div>
        {source==="file"?<div className="converter-drop"><button className="primary" disabled={!ready||busy||!!jobId} onClick={()=>void run(()=>upload("media"))}>Choose audio or video</button><p className="help">MP3, WAV, FLAC, MP4 and more</p></div>:<div className="converter-link"><label className="field">Media link<input value={url} onChange={e=>setUrl(e.target.value)} placeholder="YouTube, TikTok or Discord media URL"/></label>
        <div className="button-row"><button className="primary" disabled={!ready||busy||!!jobId||!url.trim()} onClick={()=>void run(async()=>{const result=await converterRequest<{task_id:string}>("/api/convert",{media_url:url,device});setJobId(result.task_id);setJob({status:"queued"});})}>Convert link</button>{jobId&&<button onClick={()=>void run(()=>converterRequest(`/api/stop/${jobId}`,{}))}>Cancel</button>}</div></div>}
        <details className="converter-advanced"><summary>Processing options</summary><label className="field">Compute device<select value={device} disabled={!ready||busy} onChange={e=>void run(()=>savePreference("compute_device",e.target.value))}><option value="cpu">CPU · 2 threads</option><option value="cuda" disabled={runtime?.status.installed!=="cuda"}>NVIDIA CUDA</option></select></label></details>
        {job&&<div className="control-block" role="status"><h2>{job.status==="completed"?"MIDI ready":job.status==="error"?"Conversion failed":job.status==="cancelled"?"Conversion cancelled":"Converting…"}</h2><p>{job.error??job.progress??job.midi_name}</p>{jobId&&source==="file"&&<button onClick={()=>void run(()=>converterRequest(`/api/stop/${jobId}`,{}))}>Cancel</button>}{job.status==="completed"&&<div className="button-row"><button className="primary" disabled={!ready||busy||!job.midi_name} onClick={()=>openSheet(job.midi_name!)}>Make sheet</button><button disabled={!ready||busy||!job.midi_name} onClick={()=>void openVisualizer(job.midi_name!)}>Preview piano</button><button onClick={()=>setSection("Library")}>Open in Library</button></div>}{job.status==="error"&&device==="cuda"&&<button onClick={()=>void run(async()=>{await savePreference("compute_device","cpu");setMessage("CPU selected. Submit the file or link again to retry.");})}>Use CPU for retry</button>}</div>}
        <p className="help">Best for solo piano. Mixed instruments may produce extra or missing notes.</p></section>
        <aside className="secondary-panel"><h2>Your MIDI library</h2><p className="help">Already have MIDI files or an old mp3converter library?</p><div className="button-row"><button disabled={!ready||busy} onClick={()=>void run(()=>upload("midi"))}>Import MIDI</button><button disabled={!ready} onClick={()=>setSection("Library")}>Open Library ({files.length})</button></div>
          <button disabled={!ready||busy||!!jobId} onClick={()=>void importLibrary()}>Import history & MIDI folder</button><p className="help">Choose the old converter folder or its converted folder. Files are copied; originals stay untouched.</p>
          {files.slice(0,3).map(f=><div className="details-row converter-recent" key={f.filename}><span title={f.video_title||f.filename}>{f.video_title||f.filename}</span><button disabled={!ready||busy} onClick={()=>openSheet(f.filename)}>Sheet</button></div>)}
          <details className="converter-advanced"><summary>Extension and runtime</summary>
          <button disabled={!ready||busy} onClick={()=>void run(async()=>setPairing(await converterRequest("/api/pairing",{})))}>Pair browser extension</button>{pairing&&<p>Endpoint: <code>{pairing.endpoint}</code><br/>Pairing code: <code>{pairing.code}</code> · valid 5 minutes</p>}
          <p className="help">Use the lazymidi extension for supported links or an already downloaded MuseScore MIDI.</p>
          <button disabled={!installed||busy||setupBusy||!!jobId} onClick={()=>void run(()=>dialog("converter_install",{variant:"cpu",local:true}))}>Replace runtime from pack</button></details>
        </aside></div>}
      {section==="Library"&&<section className="converter-library-section"><div className="button-row converter-library-toolbar"><input aria-label="Search library" placeholder="Search library…" value={search} onChange={e=>setSearch(e.target.value)}/><button disabled={!ready||busy} onClick={()=>void run(refresh)}>Refresh</button><button disabled={!ready||busy} onClick={()=>void run(()=>upload("midi"))}>Import MIDI</button><button disabled={!ready||busy||!!jobId} onClick={()=>void importLibrary()}>Import history & MIDI folder</button></div><p className="help">Import from your old converter folder, AudioConverterData, or any folder of MIDI files. Existing files are preserved.</p>
        <div className="converter-library">{matchingFiles.slice(currentPage*24,(currentPage+1)*24).map(f=><article className="song-card" key={f.filename} aria-label={f.video_title||f.filename}>
          <SongPreview title={f.video_title||f.filename} thumbnail={f.thumbnail_url} disabled={!ready||busy} onClick={()=>void openVisualizer(f.filename)}/>
          <div className="song-card-info"><h2 title={f.video_title||f.filename}>{f.video_title||f.filename}</h2><small>{f.time_str} · {size(f.file_size)} · {f.source_type||"MIDI"}</small></div>
          <div className="song-card-actions"><button disabled={!ready||busy} onClick={()=>openSheet(f.filename)}>Sheet</button><button onClick={()=>void exportFile(f.filename)}>Export</button><button aria-label={`Delete ${f.filename}`} onClick={()=>void run(async()=>{if(await api.ask(`Delete ${f.filename} and its sheets from lazymidi?`)){await converterRequest("/api/history/delete",{midi_filename:f.filename});if(selected===f.filename)chooseMidi("");await refresh();}})}>×</button></div>
        </article>)}</div>
        {pages>1&&<div className="button-row library-pages"><span>{currentPage*24+1}–{Math.min((currentPage+1)*24,matchingFiles.length)} of {matchingFiles.length}</span><button disabled={currentPage===0} onClick={()=>setPage(p=>p-1)}>Previous page</button><button disabled={currentPage===pages-1} onClick={()=>setPage(p=>p+1)}>Next page</button></div>}
        {!matchingFiles.length&&<div className="converter-empty"><h2>{files.length?"No matching MIDI":"Your MIDI library is empty"}</h2><p>{files.length?"Try another search.":"Convert piano audio or import a MIDI to get started."}</p></div>}<details><summary>Conversion history ({history.length})</summary>{history.filter(h=>`${h.video_title} ${h.midi_name}`.toLowerCase().includes(search.toLowerCase())).map((h,i)=><div className="details-row converter-history-row" key={i}><span>{h.video_title||h.midi_name}</span><small>{h.type} · {new Date(h.timestamp*1000).toLocaleString()}</small><button onClick={()=>void run(async()=>{if(await api.ask("Delete this history entry and associated output?")){await converterRequest("/api/history/delete",{timestamp:h.timestamp});if(selected===h.midi_name)chooseMidi("");await refresh();}})}>Delete</button></div>)}</details>
      </section>}
      {section==="Sheets"&&<label className="field">MIDI<select value={selected} onChange={e=>{chooseMidi(e.target.value);}}><option value="">Select MIDI</option>{files.map(f=><option key={f.filename} value={f.filename}>{f.video_title||f.filename}</option>)}</select></label>}
      {section==="Sheets"&&<div className="split converter-workflow"><section className="primary-panel"><div className="section-heading"><h2>Virtual Piano sheet</h2><label className="toggle"><input type="checkbox" disabled={!ready||busy} checked={!!settings.always_open_float} onChange={e=>void run(()=>savePreference("always_open_float",e.target.checked))}/>Always open Float</label></div>
        <div className="segmented sheet-modes" role="group" aria-label="Transpose mode">{Object.entries(transposeModes).map(([value,label])=><button key={value} disabled={busy} aria-pressed={settings.transpose_mode===value} onClick={()=>sheetOption("transpose_mode",value)}>{label}</button>)}</div>
        <p className="help">{transposeHelp[settings.transpose_mode as keyof typeof transposeHelp]}</p>
        <div className="button-row"><button className="primary" disabled={!ready||busy||!selected} onClick={()=>void run(()=>generateSheet())}>Generate</button><button disabled={!sheetId||busy} onClick={()=>void exportFile(sheetId)}>Export</button><button disabled={!sheet||busy} onClick={()=>void run(async()=>{await api.openOverlay("sheet");})}>Float sheet</button></div>
        <SheetTools text={sheet} colored={sheetColors} onColored={setSheetColors} centered={!!settings.center_sheet_text} onCentered={v=>setting("center_sheet_text",v)} zoom={sheetZoom} onZoom={setSheetZoom} onError={onError}/>
        <div className="sheet-output">{sheet?<SheetText text={sheet} colored={sheetColors} centered={!!settings.center_sheet_text} zoom={sheetZoom} lineAction={settings.transpose_mode==="manual"?i=>lineMap[i]!=null&&lineMap[i]>=0&&<button className="sheet-point-action" aria-label={`Add transpose at chord ${lineMap[i]}`} onClick={()=>void run(async()=>{const value=manualPoints();value.push({chord:lineMap[i],value:transpose});setPoints(JSON.stringify(value));})}>+</button>:undefined}/>:<p className="muted">Choose a MIDI above, then Generate.</p>}</div>
      </section><aside className="secondary-panel"><h2>Sheet settings</h2>
        {settings.transpose_mode==="manual"&&<><div className="converter-options"><label className="field">Chord index (from 0)<input type="number" min="0" step="1" value={pointChord} onChange={e=>setPointChord(+e.target.value)}/></label><label className="field">Game transpose<input type="number" min="-50" max="50" step="1" value={transpose} onChange={e=>setTranspose(+e.target.value)}/></label></div><button disabled={!Number.isInteger(pointChord)||pointChord<0||!Number.isInteger(transpose)||transpose < -50||transpose > 50} onClick={()=>void run(async()=>setPoints(JSON.stringify([...manualPoints(),{chord:pointChord,value:transpose}])))}>Add transpose point</button><p className="help">Or use + beside a sheet line. Generate applies edits.</p>
          {displayedPoints.map((point,i)=><div className="details-row transpose-point" key={i}><span>Chord {point.chord}</span><input aria-label={`Game transpose at chord ${point.chord}`} type="number" min="-50" max="50" step="1" value={point.value} onChange={e=>setPoints(JSON.stringify(displayedPoints.map((p,n)=>n===i?{...p,value:+e.target.value}:p)))}/><button className="sheet-point-action" aria-label={`Remove point ${i+1}`} onClick={()=>setPoints(JSON.stringify(displayedPoints.filter((_,n)=>n!==i)))}>×</button></div>)}
          <details className="converter-advanced"><summary>Advanced point import</summary><label className="field">Manual points (chord / value JSON)<textarea value={points} onChange={e=>setPoints(e.target.value)}/></label></details></>}
        <div className="sheet-timing"><h3>Tempo & timing</h3>
          <label className="toggle"><input type="checkbox" disabled={busy} checked={!!settings.show_bpm_changes_as_comments} onChange={e=>sheetOption("show_bpm_changes_as_comments",e.target.checked)}/>Show BPM & tempo changes</label>
          <label className="toggle"><input type="checkbox" disabled={busy} checked={!!settings.show_tempo_timing_marks} onChange={e=>sheetOption("show_tempo_timing_marks",e.target.checked)}/>Show timing markers</label>
          <label className="field">Chord grouping (ms)<input type="number" min="0" max="1000" value={Number(settings.quantize)} onChange={e=>setting("quantize",+e.target.value)}/></label>
          <label className="field">Line breaks<select value={String(settings.break_lines_how)} onChange={e=>setting("break_lines_how",e.target.value)}><option value="automatically">Automatic · 4 beats</option><option value="manually">Custom beats per line</option></select></label>
          <label className="field">{settings.transpose_mode==="multi"?"Beats per line / transpose region":"Beats per line"}<input type="number" min="1" max="1000" disabled={settings.break_lines_how==="automatically"&&settings.transpose_mode!=="multi"} value={Number(settings.break_lines_every)} onChange={e=>setting("break_lines_every",+e.target.value)}/></label>
        </div>
        <details className="converter-advanced"><summary>Advanced sheet formatting</summary><label className="field">Transpose resilience<input type="number" min="0" max="100" value={Number(settings.resilience)} onChange={e=>setting("resilience",+e.target.value)}/></label>{([['place_shifted_notes','Shift notes'],['place_out_of_range_notes','Extended notes']] as const).map(([key,label])=><label className="field" key={key}>{label}<select value={String(settings[key])} onChange={e=>setting(key,e.target.value)}>{Object.entries({start:"At start of chord",end:"At end of chord",inorder:"In pitch order"}).map(([v,text])=><option key={v} value={v}>{text}</option>)}</select></label>)}
          {Object.entries({classic_chord_order:"Classic chord order",sequential_quantizes:"Sequential chord grouping",curly_braces_for_quantized_chords:"Curly braces for grouped chords",include_out_of_range:"Include extended notes",show_out_of_range_text_marks:"Mark extended notes"}).map(([key,label])=><label className="toggle" key={key}><input type="checkbox" checked={!!settings[key]} onChange={e=>setting(key,e.target.checked)}/>{label}</label>)}<label className="field">Extended note separator<input value={String(settings.out_of_range_separator)} onChange={e=>setting("out_of_range_separator",e.target.value)}/></label>
        </details><button disabled={!ready||busy} onClick={()=>void run(saveSettings)}>Save settings</button>
      </aside></div>}
    {(message||runtime?.status.error)&&<p role="status" className="help">{runtime?.status.error||message}</p>}
  </div>;
}
