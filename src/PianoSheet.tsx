import {useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import type {ReactNode} from "react";
import {GraphicalMeasure,OpenSheetMusicDisplay,PointF2D} from "opensheetmusicdisplay";
import {Midi} from "@tonejs/midi";
import {convertFileSrc,invoke} from "@tauri-apps/api/core";
import {emit,listen} from "@tauri-apps/api/event";
import * as api from "./backend";
import {converterRequest,defaults,displayName,visualizerSetting} from "./converter-api";
import type {PianoContent,PianoOptions,Values} from "./converter-api";
import {scoreCursor,scoreLayout,scorePosition} from "./piano-score";
import type {ScoreLayout} from "./piano-score";
import {printPiano} from "./piano-print";

export default function PianoSheet({content,revision,zoom,busy,active=true,onZoom,onGenerate,onOpen,onError,viewOptions}:{
  content:PianoContent;revision:number;zoom:number;busy:boolean;active?:boolean;onZoom:(zoom:number)=>void;
  onGenerate:(options:PianoOptions)=>void;onOpen:()=>void;onError:(message:string)=>void;viewOptions:ReactNode;
}) {
  const container=useRef<HTMLDivElement>(null),paper=useRef<HTMLDivElement>(null),frame=useRef<HTMLIFrameElement>(null);
  const renderer=useRef<OpenSheetMusicDisplay|null>(null);
  const layout=useRef<ScoreLayout>({starts:[],lines:[],notes:new WeakMap()});
  const ready=useRef<{revision:number;loaded:boolean}|null>(null);
  const clock=useRef(0);
  const [follow,setFollow]=useState(true),[renderError,setRenderError]=useState(""),[loading,setLoading]=useState(true);
  const [playerHeight,setPlayerHeight]=useState(96);
  const [exporting,setExporting]=useState(false);
  const title=displayName(content.midi_filename.replace(/\.(mid|midi)$/i,"")).trim();
  const followRef=useRef(follow);followRef.current=follow;
  const zoomRef=useRef(zoom);zoomRef.current=zoom;
  const requestRef=useRef({content,revision,active,busy});requestRef.current={content,revision,active,busy};
  const windowVisible=useRef(true);
  const settings=useRef<Values>({...defaults});
  const [tracks,setTracks]=useState(content.track_ids);
  const [split,setSplit]=useState(String(content.split));
  const [rhythm,setRhythm]=useState(content.rhythm);
  const midi=useMemo(()=>new Midi(Uint8Array.from(atob(content.midi_base64),c=>c.charCodeAt(0))),[content.midi_base64]);
  const timeline=useMemo(()=>({midi,timing:content.timing??[],times:content.timing?.map(point=>point.time)??[]}),[midi,content.timing]);
  const timelineRef=useRef(timeline);timelineRef.current=timeline;

  function updateCursor(time:number){
    clock.current=time;
    const osmd=renderer.current,scroller=container.current;
    if(!osmd?.IsReadyToRender()||!scroller)return;
    const {midi,timing,times}=timelineRef.current;
    let beat=midi.header.secondsToTicks(Math.max(0,time))/midi.header.ppq;
    if(timing.length>1){
      const index=Math.min(scorePosition(times,time),timing.length-2),a=timing[index],b=timing[index+1];
      beat=a.beat+(time-a.time)/(b.time-a.time)*(b.beat-a.beat);
    }
    const position=scoreCursor(layout.current,Math.max(0,beat));
    if(!position)return;
    const {system,x}=position,box=system.PositionAndShape;
    const bottom=system.StaffLines.at(-1)!.PositionAndShape.AbsolutePosition.y+4;
    const marker=osmd.cursor.cursorElement,scale=10*osmd.Zoom;
    marker.width=12;
    marker.style.left="0px";marker.style.top="0px";
    marker.style.transform=`translate3d(${x*scale-marker.width/2}px, ${box.AbsolutePosition.y*scale}px, 0)`;
    marker.height=Math.round((bottom-box.AbsolutePosition.y)*scale);
    if(followRef.current){
      const bounds=marker.getBoundingClientRect(),viewport=scroller.getBoundingClientRect();
      const margin=24,top=bounds.top+box.BorderTop*scale;
      const height=Math.min((box.BorderBottom-box.BorderTop)*scale,viewport.height-margin*2);
      if(time<=0){scroller.scrollTop=0;scroller.scrollLeft=0;}
      else if(top+height>viewport.bottom-margin+1||top<viewport.top+margin-1)scroller.scrollTop+=top-viewport.top-margin;
      if(bounds.right>viewport.right-24)scroller.scrollLeft+=bounds.right-viewport.right+24;
      else if(bounds.left<viewport.left+24)scroller.scrollLeft+=bounds.left-viewport.left-24;
    }
  }

  function reportReady(loaded:boolean){
    const value={revision:requestRef.current.revision,loaded};
    if(ready.current?.revision===value.revision&&ready.current.loaded===loaded)return;
    ready.current=value;
    void emit("piano-sheet-ready",value).catch(e=>onError(api.errorText(e)));
  }

  function redraw(){
    const osmd=renderer.current,node=paper.current;
    if(!osmd?.IsReadyToRender()||!node||!requestRef.current.active)return;
    try{
      node.style.minWidth="280px";osmd.Zoom=zoomRef.current*.8;osmd.render();
      const measures=osmd.GraphicSheet.MeasureList.flat().filter(Boolean),rules=osmd.EngravingRules;
      const minimum=Math.max(0,...measures.map(m=>m.minimumStaffEntriesWidth+m.endInstructionsWidth))+Math.max(0,...measures.map(m=>m.beginInstructionsWidth));
      const width=Math.ceil((minimum+rules.PageLeftMargin+rules.PageRightMargin+rules.SystemLeftMargin+rules.SystemRightMargin)*10*osmd.Zoom);
      // Overcompressing a measure can reverse the engraver's note positions.
      if(width>node.clientWidth){node.style.minWidth=`${Math.max(280,width)}px`;osmd.render();}
      layout.current=scoreLayout(osmd.GraphicSheet);
      if(!layout.current.lines.length)throw new Error("No measures could be laid out.");
      osmd.cursor.show();
      osmd.cursor.cursorElement.classList.add("piano-score-cursor");osmd.cursor.cursorElement.alt="";
      updateCursor(clock.current);
      setRenderError("");reportReady(true);
    }catch(e){layout.current={starts:[],lines:[],notes:new WeakMap()};setRenderError(api.errorText(e));reportReady(false);}
  }

  function seekScore(x:number,y:number,target:EventTarget){
    const osmd=renderer.current;
    if(!osmd?.IsReadyToRender()||busy||!active||renderError)return;
    let node=target instanceof Element?target:null,beat:number|undefined;
    while(node&&beat===undefined){beat=layout.current.notes.get(node);node=node.parentElement;}
    if(beat===undefined){
      const score=osmd.GraphicSheet,point=score.svgToOsmd(score.domToSvg(new PointF2D(x,y)));
      const timestamp=score.GetNearestNote(point,new PointF2D(2,2))?.sourceNote.getAbsoluteTimestamp()
        ??score.tryGetTimeStampFromPosition(point)??score.GetNearestObject<GraphicalMeasure>(point,GraphicalMeasure.name)?.parentSourceMeasure.AbsoluteTimestamp;
      if(!timestamp)return;
      beat=timestamp.RealValue*4;
    }
    const {midi,timing}=timelineRef.current;
    let time=midi.header.ticksToSeconds(beat*midi.header.ppq);
    if(timing.length>1){
      const index=Math.min(scorePosition(timing.map(point=>point.beat),beat),timing.length-2),a=timing[index],b=timing[index+1];
      time=a.time+(beat-a.beat)/(b.beat-a.beat)*(b.time-a.time);
    }
    if(!Number.isFinite(time))return;
    time=Math.max(0,time);
    send({type:"converter-seek",revision:requestRef.current.revision,time});
    updateCursor(time);
  }

  useEffect(()=>{
    let disposed=false,resizeFrame=0;
    setLoading(true);setRenderError("");clock.current=0;ready.current=null;
    layout.current={starts:[],lines:[],notes:new WeakMap()};
    const osmd=new OpenSheetMusicDisplay(paper.current!,{backend:"svg",autoResize:false,drawingParameters:"compact",drawCredits:false,
      drawPartNames:false,drawMeasureNumbers:true,drawMetronomeMarks:true,followCursor:false,
      cursorsOptions:[{type:1,color:"#397c63",alpha:0.18,follow:false}]});
    osmd.EngravingRules.TupletNumberLimitConsecutiveRepetitions=false;
    osmd.EngravingRules.AutoGenerateMultipleRestMeasuresFromRestMeasures=false;
    osmd.EngravingRules.VoiceSpacingMultiplierVexflow=1;
    renderer.current=osmd;
    void osmd.load(content.musicxml).then(()=>{
      if(disposed)return;
      redraw();
      setLoading(false);
    }).catch(e=>{if(!disposed){setLoading(false);setRenderError(api.errorText(e));reportReady(false);}});
    let width=0;
    const observer=new ResizeObserver(entries=>{
      const next=entries[0]?.contentRect.width??0;
      if(next<=0)return;
      cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{
        if(next!==width){width=next;redraw();}else updateCursor(clock.current);
      });
    });
    observer.observe(container.current!);
    return()=>{disposed=true;observer.disconnect();cancelAnimationFrame(resizeFrame);osmd.clear();if(renderer.current===osmd)renderer.current=null;};
  },[content.musicxml,midi,revision]);
  useEffect(redraw,[zoom,active]);
  useEffect(()=>{if(follow)updateCursor(clock.current);},[follow]);
  useEffect(()=>{setTracks(content.track_ids);setSplit(String(content.split));setRhythm(content.rhythm);},[content]);

  const send=(value:object)=>frame.current?.contentWindow?.postMessage(value,location.origin);
  const sendVisibility=()=>send({type:"converter-visibility",visible:requestRef.current.active&&!requestRef.current.busy&&windowVisible.current&&!document.hidden});
  function loadPlayer(){
    const current=requestRef.current;
    send({type:"converter-visualize",filename:current.content.midi_filename,revision:current.revision,
      midiBase64:current.content.midi_base64,settings:settings.current,assetRoot:convertFileSrc("/","converter")});
    sendVisibility();
  }
  useEffect(()=>{loadPlayer();},[revision]);
  useEffect(sendVisibility,[busy,active]);
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
        settings.current={...settings.current,...changed};
        void converterRequest<Values>("/api/settings").then(latest=>converterRequest("/api/settings",{...latest,...changed})).catch(e=>onError(api.errorText(e)));
      }
    };
    const visibility=()=>sendVisibility();
    const playerWindow=frame.current?.contentWindow as (Window&{setVisualizerActive?:(visible:boolean)=>void})|null;
    const stop=()=>{playerWindow?.setVisualizerActive?.(false);playerWindow?.postMessage({type:"converter-visibility",visible:false},location.origin);};
    window.addEventListener("message",handle);document.addEventListener("visibilitychange",visibility);window.addEventListener("beforeunload",stop);
    void listen<boolean>("sheet-visibility",e=>{windowVisible.current=e.payload;sendVisibility();}).then(f=>{if(disposed)f();else stopVisibility=f;});
    return()=>{disposed=true;stop();stopVisibility();window.removeEventListener("message",handle);document.removeEventListener("visibilitychange",visibility);window.removeEventListener("beforeunload",stop);};
  },[]);

  async function exportScore(print:boolean){
    if(exporting||busy||loading||renderError)return;
    setExporting(true);
    try{
      const player=frame.current?.contentWindow as (Window&{pausePianoPlayback?:()=>Promise<void>})|null;
      await player?.pausePianoPlayback?.();
      await api.whilePaused(async()=>{
        if(print)await printPiano(content.musicxml,title);
        else await invoke("export_piano_sheet",{expectedRevision:revision});
      });
    }catch(error){onError(api.errorText(error));}
    finally{setExporting(false);sendVisibility();}
  }

  return <section className="piano-sheet" hidden={!active}>
    <div className="sheet-tools sheet-toolbar">
      <button disabled={busy} onClick={onOpen}>Open MIDI</button>
      <details name="piano-tools" className="piano-score-options"><summary>Tracks & rhythm</summary><div className="piano-score-panel">
        <fieldset><legend>MIDI source tracks</legend>{content.tracks.map(track=><label className="toggle" key={track.id}>
          <input type="checkbox" checked={tracks.includes(track.id)} onChange={e=>setTracks(v=>e.target.checked?[...v,track.id]:v.filter(t=>t!==track.id))}/>{track.name}
        </label>)}</fieldset>
        <label>Staff split (C4 = 60)<input aria-label="Staff split" type="number" min="21" max="108" value={split} onChange={e=>setSplit(e.target.value)}/></label>
        <label>Rhythm<select value={rhythm} onChange={e=>setRhythm(e.target.value as "normal"|"fine")}><option value="normal">Standard (sixteenths)</option><option value="fine">Detailed (thirty-seconds)</option></select></label>
        {content.estimated_tempo&&<p className="help">Score rhythm estimated at {content.estimated_tempo} BPM. Playback keeps the original performance.</p>}
        <button disabled={busy||!tracks.length||!split.trim()||!Number.isInteger(+split)||+split<21||+split>108} onClick={e=>{onGenerate({track_ids:tracks,split:+split,rhythm});e.currentTarget.closest("details")!.open=false;}}>Apply to score</button>
      </div></details>
      <details name="piano-tools" className="piano-score-options"><summary>Export</summary><div className="piano-score-panel">
        <button disabled={exporting||busy||loading||!!renderError} onClick={()=>void exportScore(false)}>Export MusicXML</button>
        <button disabled={exporting||busy||loading||!!renderError} onClick={()=>void exportScore(true)}>Print / Save PDF</button>
        {exporting&&<p role="status">Preparing export…</p>}
      </div></details>
      <label><input type="checkbox" checked={follow} onChange={e=>setFollow(e.target.checked)}/>Follow</label>
      <details name="piano-tools" className="sheet-view-options"><summary>View</summary><div className="sheet-view-panel">
        <label>Zoom<input aria-label="Sheet zoom" type="range" min="0.5" max="3" step="0.1" value={zoom} onChange={e=>onZoom(+e.target.value)}/></label>{viewOptions}
      </div></details>
    </div>
    {loading&&<p role="status">Drawing score…</p>}
    {renderError&&<p role="alert">Could not draw this score: {renderError}</p>}
    <div className="piano-score-scroll" ref={container} tabIndex={0} aria-label="Piano notation" onWheel={()=>setFollow(false)} onTouchMove={()=>setFollow(false)}
      onPointerDown={e=>{const bounds=e.currentTarget.getBoundingClientRect();if(e.clientX>=bounds.right-18||e.clientY>=bounds.bottom-18)setFollow(false);}}
      onKeyDown={e=>{if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","PageUp","PageDown","Home","End"].includes(e.key))setFollow(false);}}>
      <div className="piano-score-paper" ref={paper} onClick={e=>seekScore(e.clientX,e.clientY,e.target)}/>
    </div>
    <iframe title="Piano playback" className="piano-score-player" ref={frame} src="/converter/visualizer.html?score=1" style={{height:playerHeight}} onLoad={loadPlayer}/>
  </section>;
}
