import {useNoticeText} from "./notices";
import { useState,useRef,useEffect,type KeyboardEvent } from "react";
import * as api from "./backend";
import { codeToHid,keyLabel } from "./Piano88";

type Binding="up"|"down"|"next_shortcut"|"previous_shortcut"|"pause_shortcut";

export default function Transposer({state,profile,edit,send,apply,discard,dirty,busy}: {
  state:api.Snapshot; profile:api.Profile; edit:(f:(p:api.Profile)=>void)=>void;
  send:(type:string,fields?:Record<string,unknown>)=>unknown; apply:()=>unknown; discard:()=>void; dirty:boolean; busy:boolean;
}) {
  const captureReason=useRef(Symbol("transpose-binding"));
  useEffect(()=>()=>{void api.pauseOutput(captureReason.current,false);},[]);
  const [sequence,setSequence]=useState<string|null>(null);
  const [capture,setCapture]=useState<Binding|null>(null);
  const [error,setError]=useState("");
  const config=profile.transpose;
  const status=state.transpose;
  const statusError=useNoticeText(status.error);
  useEffect(()=>{if(!dirty){setSequence(null);setError("");}},[dirty,profile.id]);
  function stopCapture(){setCapture(null);void api.pauseOutput(captureReason.current,false);}
  function captureKey(event:KeyboardEvent<HTMLButtonElement>,binding:Binding){
    if(capture!==binding)return;
    event.preventDefault();event.stopPropagation();
    if(event.code==="Escape"){stopCapture();return;}
    const hid=codeToHid(event.code);
    if(hid===null){setError("That key is not supported. Choose another key or press Escape.");return;}
    if(hid>=224&&hid<=231)return;
    if(binding==="up"||binding==="down"){
      if(hid>=104){setError("Use a supported key such as an arrow or F1–F12.");return;}
      edit(p=>{p.transpose[binding]=hid;});
    }else{
      const shortcut=[event.ctrlKey?"Ctrl":null,event.altKey?"Alt":null,event.shiftKey?"Shift":null,event.metaKey?"Super":null,event.code].filter(Boolean).join("+");
      edit(p=>{p.transpose[binding]=shortcut;});
    }
    setError("");stopCapture();
  }
  const transpose=(action:string,extra={})=>send("transpose",{action,...extra});
  return <div className="split transposer">
    <section className="primary-panel">
      <div className="section-heading"><h1>Transposer</h1><span className="muted">Game controls</span></div>
      <p className="help">Set the game’s Up/Down keys and your sequence, then Apply.</p>
      <label className="field">Sequence<input value={sequence??config.sequence.join(" ")} onChange={e=>{
        const text=e.target.value;setSequence(text);
        if(!/^\s*-?\d+(?:[\s,]+-?\d+)*\s*$/.test(text)) {setError("Enter whole numbers separated by spaces.");return;}
        const values=text.trim().split(/[\s,]+/).map(Number);
        if(values.length>512||values.some(v=>v < -50 || v > 50)) {setError("Use values from −50 to 50 (up to 512).");return;}
        setError("");edit(p=>{p.transpose.sequence=values;});
      }}/></label>
      <div className="transpose-sequence">{config.sequence.map((n,i)=><button key={i} className={status.selected===i?"active":""} disabled={dirty||status.busy} onClick={()=>transpose("select",{index:i})}>{n>0?"+":""}{n}</button>)}</div>
      <div className="control-block"><h2>1. Game bindings</h2><div className="button-row">{(["down","up"] as const).map(key=><button key={key} onClick={()=>{setCapture(key);void api.pauseOutput(captureReason.current,true);}} onBlur={stopCapture} onKeyDown={e=>captureKey(e,key)}>{capture===key?"Press a key…":`${key==="up"?"Up":"Down"}: ${config[key]===null?"Unassigned":keyLabel(config[key]!)}`}</button>)}</div></div>
      <div className="control-block"><h2>2. Performance shortcuts</h2>{([['next_shortcut','Next'],['previous_shortcut','Previous'],['pause_shortcut','Pause / Resume']] as const).map(([key,label])=><div className="shortcut-binding" key={key}><label className="field">{label}<input placeholder="Unassigned" value={config[key]??""} onChange={e=>edit(p=>{p.transpose[key]=e.target.value||null;})}/></label><button aria-label={`Record ${label} shortcut`} onClick={()=>{setCapture(key);void api.pauseOutput(captureReason.current,true);}} onBlur={stopCapture} onKeyDown={e=>captureKey(e,key)}>{capture===key?"Press shortcut…":"Record"}</button><button aria-label={`Clear ${label} shortcut`} disabled={!config[key]} onClick={()=>edit(p=>{p.transpose[key]=null;})}>×</button></div>)}</div>
      {error&&<p role="alert" className="notice error">{error}</p>}
      <div className="button-row"><button className="primary" disabled={!dirty||busy||!!error||!!capture} onClick={apply}>Apply</button><button disabled={!dirty} onClick={()=>{discard();setSequence(null);setError("");}}>Discard draft</button></div>
    </section>
    <aside className="secondary-panel"><h2>Game state</h2><div className="transpose-current">{status.target??status.current??"—"}</div><p role="status">{status.busy?`Changing… ${status.completed} / ${status.total}` : status.armed?"Ready":"Paused"}</p>
      <p className="help">Automatically tracks from 0. Use shortcuts or the floating monitor while playing.</p>
      {statusError&&<p className="notice error" role="alert">{statusError}</p>}
      <div className="button-row"><button onClick={()=>void api.openOverlay("monitor").catch(e=>setError(api.errorText(e)))}>Float monitor</button><button onClick={()=>void api.openOverlay("sheet").catch(e=>setError(api.errorText(e)))}>Float sheet</button></div>
    </aside>
  </div>;
}
