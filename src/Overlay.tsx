import {useEffect,useLayoutEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {open} from "@tauri-apps/plugin-dialog";
import * as api from "./backend";
import {SheetText,SheetTools} from "./SheetText";
import TitleBar from "./TitleBar";
import {gamePoints,transposeModes} from "./converter-api";
import type {Point,SheetContent,Values} from "./converter-api";

function TransposeValue({value,chord,disabled,onCommit,onError}:{value:number;chord:number;disabled:boolean;onCommit:(value:number)=>void;onError:(message:string)=>void}){
  const [draft,setDraft]=useState(String(value));useEffect(()=>setDraft(String(value)),[value]);
  function commit(){const next=Number(draft);if(!draft.trim()||!Number.isInteger(next)||next < -50||next>50){setDraft(String(value));onError("Transpose must be an integer from −50 to 50.");return;}if(next!==value)onCommit(next);}
  return <strong className="sheet-transpose">Transpose by: <input aria-label={`Game transpose at chord ${chord}`} className="sheet-transpose-input" type="number" min="-50" max="50" step="1" disabled={disabled} value={draft} onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.blur();}}/></strong>;
}

export default function Overlay({kind}:{kind:string}) {
  const [state,setState]=useState(api.initialState());
  const [sheet,setSheet]=useState<SheetContent>({text:""});const sheetRef=useRef(sheet);sheetRef.current=sheet;
  const scroll=useRef<HTMLDivElement>(null);const restoreScroll=useRef<number|null>(null);const [busy,setBusy]=useState(false);
  const [zoom,setZoom]=useState(1); const [opacity,setOpacity]=useState(1);
  const [top,setTop]=useState(true);
  const [colored,setColored]=useState(true);const [centered,setCentered]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{if(kind==="sheet")document.documentElement.classList.add("sheet-window");return()=>document.documentElement.classList.remove("sheet-window");},[kind]);
  useEffect(()=>{let stop=()=>{};let sheetStop=()=>{};let disposed=false;
    const accept=(s:api.Snapshot)=>setState(p=>s.state_sequence>=p.state_sequence?s:p);
    const failed=(e:unknown)=>{if(!disposed)setError(api.errorText(e));};
    void api.getState().then(accept).catch(failed);void api.subscribe(accept).then(f=>{if(disposed)f();else stop=f;}).catch(failed);
    let receivedSheet=false;
    void listen<typeof sheet>("sheet-content",e=>{receivedSheet=true;if(!disposed)setSheet(p=>(e.payload.revision??0)>=(p.revision??0)?e.payload:p);}).then(async f=>{
      if(disposed){f();return;}sheetStop=f;
      const initial=await invoke<typeof sheet>("get_sheet");
      if(!disposed&&!receivedSheet)setSheet(initial);
    }).catch(failed);
    return ()=>{disposed=true;stop();sheetStop();};},[]);
  const config=state.settings.profiles.find(p=>p.id===state.settings.selected_profile)!.transpose;const sequence=config.sequence;
  const status=state.transpose;
  const bindingsReady=config.up!==null&&config.down!==null;
  useEffect(()=>{if(kind==="monitor"&&bindingsReady&&status.current!==null)setError("");},[kind,bindingsReady,status.current,status.armed]);
  const accept=(s:api.Snapshot)=>setState(p=>s.state_sequence>=p.state_sequence?s:p);
  async function command(action:string){if(busy)return;setBusy(true);setError("");
    try{accept(await api.command({type:"transpose",action}));}
    catch(e){setError(api.errorText(e));}finally{setBusy(false);}
  }
  async function sendTransposes(values:number[]){setBusy(true);setError("");try{accept(await api.sendTransposeSequence(values));}catch(e){setError(api.errorText(e));}finally{setBusy(false);}}
  const options=(newTop:boolean)=>void invoke("overlay_options",{kind,top:newTop}).then(()=>setTop(newTop)).catch(e=>setError(api.errorText(e)));
  useLayoutEffect(()=>{if(restoreScroll.current!==null&&scroll.current){scroll.current.scrollTop=restoreScroll.current;restoreScroll.current=null;}},[sheet]);
  async function regenerate(changes:Values){const current=sheetRef.current;if(!current.source||busy)return;setBusy(true);setError("");restoreScroll.current=scroll.current?.scrollTop??0;
    try{const value=await invoke<SheetContent>("generate_sheet",{midiFilename:current.source.midi_filename,settings:{...current.source.settings,...changes},expectedRevision:current.revision??null});setSheet(p=>(value.revision??0)>=(p.revision??0)?value:p);}
    catch(e){restoreScroll.current=null;setError(api.errorText(e));}finally{setBusy(false);}
  }
  const points=sheet.source?gamePoints(sheet.source.settings):[];
  function changePoint(chord:number,value:number){const updated:Point[]=[...points.filter(p=>p.chord!==chord),{chord,value}].sort((a,b)=>a.chord-b.chord);void regenerate({manual_transpose_points:updated.map(p=>({...p,value:-p.value}))});}
  function removePoint(chord:number){void regenerate({manual_transpose_points:points.filter(p=>p.chord!==chord).map(p=>({...p,value:-p.value}))});}
  function inheritedValue(chord:number){return [...points].sort((a,b)=>a.chord-b.chord).filter(p=>p.chord<=chord).at(-1)?.value??0;}
  const manual=sheet.source?.settings.transpose_mode==="manual";
  const modeControl=<select aria-label="Transpose mode" title={!sheet.source?"Requires source MIDI":undefined} disabled={!sheet.source||busy} value={String(sheet.source?.settings.transpose_mode??"none")} onChange={e=>void regenerate({transpose_mode:e.target.value})}>{Object.entries(transposeModes).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>;
  return <div className={`aux-window ${kind==="monitor"?"monitor-window":""}`}><TitleBar label={kind==="monitor"?"Monitor":"Sheet"} onError={setError}/><div className="overlay" style={{opacity}}>{kind==="monitor"?<>
    <div className="monitor-values"><span>{sequence[(status.selected+sequence.length-1)%sequence.length]}</span><strong>{status.target??status.current??"—"}</strong><span>{sequence[(status.selected+1)%sequence.length]}</span></div>
    <div className="button-row monitor-controls"><button disabled={busy||!status.armed||status.busy||status.editing} onClick={()=>void command("previous")}>Previous</button><button title={!bindingsReady?"Assign Up/Down in Transposer.":undefined} disabled={busy||(!status.armed&&(!bindingsReady||status.editing))} onClick={()=>void command("toggle")}>{status.armed?"Pause":"Resume"}</button><button disabled={busy||!status.armed||status.busy||status.editing} onClick={()=>void command("next")}>Next</button></div>
  </>:<>
    <SheetTools text={sheet.image?"":sheet.text??""} image={!!sheet.image} colored={colored} onColored={setColored} centered={centered} onCentered={setCentered} zoom={zoom} onZoom={setZoom} onError={setError} hideLegend onSendTransposes={sendTransposes} busy={busy}
      onOpen={()=>void api.whilePaused(()=>open({multiple:false,filters:[{name:"Sheet",extensions:["txt","png","jpg","jpeg","webp"]}]}).then(path=>path&&invoke("overlay_sheet",{path,text:null}))).catch(e=>setError(api.errorText(e)))}
      viewOptions={<>
      <label>Opacity<input aria-label="Sheet opacity" type="range" min="0.2" max="1" step="0.05" value={opacity} onChange={e=>setOpacity(+e.target.value)}/></label>
      <label><input type="checkbox" checked={top} onChange={e=>options(e.target.checked)}/> Stay on top</label>
    </>}>
      {modeControl}
    </SheetTools>
    {busy&&<p role="status">Working…</p>}
    <div className="sheet-scroll" ref={scroll}>{sheet.image?<img alt="Piano sheet" src={sheet.image} style={{width:`${zoom*100}%`}}/>:sheet.text?<SheetText text={sheet.text} colored={colored} centered={centered} zoom={zoom}
      lineContent={manual?(line,i)=>{const match=/^Transpose by:\s*([+-]?\d+)/i.exec(line);const chord=sheet.source?.line_chord_map[i];return match&&chord!=null&&chord>=0?<TransposeValue value={Number(match[1])} chord={chord} disabled={busy} onCommit={value=>changePoint(chord,value)} onError={setError}/>:null;}:undefined}
      lineAction={manual?i=>{const chord=sheet.source?.line_chord_map[i];const line=sheet.text?.split("\n")[i]??"";if(chord==null||chord<0||!line.trim()||/^<!--/.test(line))return null;const exists=points.some(p=>p.chord===chord);if(/^Transpose by:/i.test(line))return exists?<button className="sheet-point-action" disabled={busy} aria-label={`Remove transpose at chord ${chord}`} onClick={()=>removePoint(chord)}>−</button>:null;return !exists?<button className="sheet-point-action" disabled={busy} aria-label={`Add transpose at chord ${chord}`} onClick={()=>changePoint(chord,inheritedValue(chord))}>+</button>:null;}:undefined}
    />:<p className="muted">Open a sheet, or send one from Convert → Sheets.</p>}</div>
  </>}{(error||status.error)&&<p role="alert" title={error||status.error||undefined}>{error||status.error}</p>}</div></div>;
}
