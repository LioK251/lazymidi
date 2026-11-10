import {useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import type {ReactNode} from "react";
import {OpenSheetMusicDisplay} from "opensheetmusicdisplay";
import type {MusicPartManagerIterator} from "opensheetmusicdisplay";
import {Midi} from "@tonejs/midi";
import {convertFileSrc,invoke} from "@tauri-apps/api/core";
import {emit,listen} from "@tauri-apps/api/event";
import * as api from "./backend";
import {converterRequest,defaults,displayName,visualizerSetting} from "./converter-api";
import type {PianoContent,PianoOptions,Values} from "./converter-api";

export function scorePosition(times:number[],time:number):number {
  let low=0,high=times.length;
  while(low<high){const mid=(low+high)>>>1;if(times[mid]<=time)low=mid+1;else high=mid;}
  return Math.max(0,low-1);
}

export default function PianoSheet({content,revision,zoom,busy,onZoom,onGenerate,onOpen,onError,viewOptions}:{
  content:PianoContent;revision:number;zoom:number;busy:boolean;onZoom:(zoom:number)=>void;
  onGenerate:(options:PianoOptions)=>void;onOpen:()=>void;onError:(message:string)=>void;viewOptions:ReactNode;
}) {
  const container=useRef<HTMLDivElement>(null),paper=useRef<HTMLDivElement>(null),frame=useRef<HTMLIFrameElement>(null);
  const renderer=useRef<OpenSheetMusicDisplay|null>(null);
  const steps=useRef<MusicPartManagerIterator[]>([]),times=useRef<number[]>([]),position=useRef(-1),clock=useRef(0);
  const [follow,setFollow]=useState(true),[renderError,setRenderError]=useState(""),[loading,setLoading]=useState(true);
  const [playerHeight,setPlayerHeight]=useState(96);
  const followRef=useRef(follow);followRef.current=follow;
  const zoomRef=useRef(zoom);zoomRef.current=zoom;
  const requestRef=useRef({content,revision});requestRef.current={content,revision};
  const settings=useRef<Values>({...defaults});
  const [tracks,setTracks]=useState(content.track_ids);
  const [split,setSplit]=useState(String(content.split));
  const [rhythm,setRhythm]=useState(content.rhythm);
  const midi=useMemo(()=>new Midi(Uint8Array.from(atob(content.midi_base64),c=>c.charCodeAt(0))),[content.midi_base64]);

  function updateCursor(time:number,force=false){
    clock.current=time;
    const osmd=renderer.current,scroller=container.current;
    if(!osmd||!scroller||!times.current.length)return;
    const next=scorePosition(times.current,time);
    if(next!==position.current||force){
      position.current=next;osmd.cursor.iterator=steps.current[next].clone();osmd.cursor.show();osmd.cursor.update();
    }
    if(followRef.current){
      const marker=osmd.cursor.cursorElement.getBoundingClientRect(),viewport=scroller.getBoundingClientRect();
      if(time<=0)scroller.scrollTop=0;
      else if(marker.top>viewport.bottom-80||marker.bottom<viewport.top+20)scroller.scrollTop+=marker.top-viewport.top-48;
    }
  }

  useEffect(()=>{
    let disposed=false,resizeFrame=0;
    setLoading(true);setRenderError("");position.current=-1;clock.current=0;times.current=[];steps.current=[];
    const osmd=new OpenSheetMusicDisplay(paper.current!,{backend:"svg",autoResize:false,drawingParameters:"compacttight",drawCredits:false,
      drawPartNames:false,drawMeasureNumbers:true,drawMetronomeMarks:true,followCursor:false,
      cursorsOptions:[{type:0,color:"#397c63",alpha:0.3,follow:false}]});
    renderer.current=osmd;
    const redraw=()=>{
      if(disposed||!osmd.IsReadyToRender())return;
      try{osmd.Zoom=zoomRef.current;osmd.render();updateCursor(clock.current,true);}
      catch(e){setRenderError(api.errorText(e));}
    };
    void osmd.load(content.musicxml).then(()=>{
      if(disposed)return;
      redraw();
      const iterator=osmd.cursor.Iterator.clone();
      while(!iterator.EndReached){
        times.current.push(midi.header.ticksToSeconds(iterator.CurrentSourceTimestamp.RealValue*4*midi.header.ppq));
        steps.current.push(iterator.clone());iterator.moveToNext();
      }
      updateCursor(0,true);setLoading(false);
      void emit("piano-sheet-ready",{revision,loaded:!!paper.current?.querySelector("svg")});
    }).catch(e=>{if(!disposed){setLoading(false);setRenderError(api.errorText(e));}});
    let width=0;
    const observer=new ResizeObserver(entries=>{
      const next=entries[0]?.contentRect.width??0;
      if(next===width)return;width=next;cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(redraw);
    });
    observer.observe(container.current!);
    return()=>{disposed=true;observer.disconnect();cancelAnimationFrame(resizeFrame);osmd.clear();if(renderer.current===osmd)renderer.current=null;};
  },[content.musicxml,midi,revision]);
  useEffect(()=>{
    const osmd=renderer.current;if(!osmd?.IsReadyToRender())return;
    try{osmd.Zoom=zoom;osmd.render();updateCursor(clock.current,true);}catch(e){setRenderError(api.errorText(e));}
  },[zoom]);
  useEffect(()=>{if(follow)updateCursor(clock.current,true);},[follow]);
  useEffect(()=>{setTracks(content.track_ids);setSplit(String(content.split));setRhythm(content.rhythm);},[content]);

  const send=(value:object)=>frame.current?.contentWindow?.postMessage(value,location.origin);
  function loadPlayer(){
    const current=requestRef.current;
    send({type:"converter-visualize",filename:current.content.midi_filename,revision:current.revision,
      midiBase64:current.content.midi_base64,settings:settings.current,assetRoot:convertFileSrc("/","converter")});
    send({type:"converter-visibility",visible:!document.hidden});
  }
  useEffect(()=>{loadPlayer();},[revision]);
  useEffect(()=>{if(busy)send({type:"converter-visibility",visible:false});else send({type:"converter-visibility",visible:!document.hidden});},[busy]);
  // Pause while the iframe's document is still attached.
  useLayoutEffect(()=>{
    let disposed=false,stopVisibility=()=>{};
    void converterRequest<Values>("/api/settings").then(value=>{if(!disposed){settings.current={...defaults,...value};send({type:"converter-appearance",settings:settings.current});}}).catch(e=>onError(api.errorText(e)));
    const handle=(event:MessageEvent)=>{
      if(event.source!==frame.current?.contentWindow||event.origin!==location.origin)return;
      const data=event.data;
      if(data?.type==="converter-playback"&&data.revision===requestRef.current.revision&&Number.isFinite(data.time))updateCursor(data.time);
      if(data?.type==="converter-player-size"&&Number.isFinite(data.height))setPlayerHeight(Math.max(64,Math.min(220,data.height)));
      if(data?.type==="converter-fetch"){
        const target=event.source as Window;
        void converterRequest(data.path,data.body).then(value=>target.postMessage({type:"converter-fetch-result",id:data.id,value},location.origin))
          .catch(e=>target.postMessage({type:"converter-fetch-result",id:data.id,error:api.errorText(e)},location.origin));
      }
      if(data?.type==="converter-import-soundfont")void api.whilePaused(()=>invoke<{filename:string}|null>("converter_pick",{kind:"soundfont",device:null}))
        .then(value=>{if(value)send({type:"converter-soundfonts",filename:value.filename});}).catch(e=>onError(api.errorText(e)))
        .finally(()=>send({type:"converter-import-complete"}));
      if(data?.type==="converter-settings-save"){
        const changed=Object.fromEntries(Object.entries(data.settings??{}).filter(([key])=>visualizerSetting(key)));
        void converterRequest<Values>("/api/settings").then(latest=>converterRequest("/api/settings",{...latest,...changed})).catch(e=>onError(api.errorText(e)));
      }
    };
    const visibility=()=>send({type:"converter-visibility",visible:!document.hidden});
    const playerWindow=frame.current?.contentWindow;
    const stop=()=>playerWindow?.postMessage({type:"converter-visibility",visible:false},location.origin);
    window.addEventListener("message",handle);document.addEventListener("visibilitychange",visibility);window.addEventListener("beforeunload",stop);
    void listen<boolean>("sheet-visibility",e=>send({type:"converter-visibility",visible:e.payload})).then(f=>{if(disposed)f();else stopVisibility=f;});
    return()=>{disposed=true;stop();stopVisibility();window.removeEventListener("message",handle);document.removeEventListener("visibilitychange",visibility);window.removeEventListener("beforeunload",stop);};
  },[]);

  return <section className="piano-sheet">
    <div className="sheet-tools sheet-toolbar">
      <button disabled={busy} onClick={onOpen}>Open MIDI</button>
      <details className="piano-score-options"><summary>Tracks & rhythm</summary><div className="piano-score-panel">
        <fieldset><legend>Tracks</legend>{content.tracks.map(track=><label className="toggle" key={track.id}>
          <input type="checkbox" checked={tracks.includes(track.id)} onChange={e=>setTracks(v=>e.target.checked?[...v,track.id]:v.filter(t=>t!==track.id))}/>{track.name}
        </label>)}</fieldset>
        <label>Staff split (C4 = 60)<input aria-label="Staff split" type="number" min="21" max="108" value={split} onChange={e=>setSplit(e.target.value)}/></label>
        <label>Rhythm<select value={rhythm} onChange={e=>setRhythm(e.target.value as "normal"|"fine")}><option value="normal">Sixteenths & triplets</option><option value="fine">Thirty-seconds & triplets</option></select></label>
        <button disabled={busy||!tracks.length||!split.trim()||!Number.isInteger(+split)||+split<21||+split>108} onClick={e=>{onGenerate({track_ids:tracks,split:+split,rhythm});e.currentTarget.closest("details")!.open=false;}}>Apply to score</button>
      </div></details>
      <label><input type="checkbox" checked={follow} onChange={e=>setFollow(e.target.checked)}/>Follow</label>
      <details className="sheet-view-options"><summary>View</summary><div className="sheet-view-panel">
        <label>Zoom<input aria-label="Sheet zoom" type="range" min="0.5" max="3" step="0.1" value={zoom} onChange={e=>onZoom(+e.target.value)}/></label>{viewOptions}
      </div></details>
    </div>
    <p className="piano-score-title">{displayName(content.midi_filename.replace(/\.(mid|midi)$/i,""))}</p>
    {loading&&<p role="status">Drawing score…</p>}
    {renderError&&<p role="alert">Could not draw this score: {renderError}</p>}
    <div className="piano-score-scroll" ref={container} tabIndex={0} aria-label="Piano notation" onWheel={()=>setFollow(false)} onTouchMove={()=>setFollow(false)}
      onPointerDown={e=>{if(e.clientX>=e.currentTarget.getBoundingClientRect().right-18)setFollow(false);}}
      onKeyDown={e=>{if(["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"].includes(e.key))setFollow(false);}}>
      <div className="piano-score-paper" ref={paper}/>
    </div>
    <iframe title="Piano playback" className="piano-score-player" ref={frame} src="/converter/visualizer.html?score=1" style={{height:playerHeight}} onLoad={loadPlayer}/>
  </section>;
}
