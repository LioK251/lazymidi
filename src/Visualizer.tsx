import {useEffect,useRef,useState} from "react";
import {invoke,convertFileSrc} from "@tauri-apps/api/core";
import {emit,listen} from "@tauri-apps/api/event";
import * as api from "./backend";
import {StylePreviews} from "./ConverterPreviews";
import TitleBar from "./TitleBar";
import {converterRequest,defaults,visualizerSetting} from "./converter-api";
import type {Values} from "./converter-api";
type Content={midi_filename?:string;settings?:Values;revision:number};
const dialog=<T,>(command:string,args:Record<string,unknown>)=>api.whilePaused(()=>invoke<T>(command,args));
export default function Visualizer(){
  const [content,setContent]=useState<Content>({revision:0});const selected=content.midi_filename??"";
  const [settings,setSettings]=useState<Values>(defaults);const settingsRef=useRef(settings);settingsRef.current=settings;
  const frame=useRef<HTMLIFrameElement>(null);const player=useRef<Window|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [message,setMessage]=useState("");const [top,setTop]=useState(false);
  async function run<T>(action:()=>Promise<T>){setBusy(true);setError("");try{return await action();}catch(e){setError(api.errorText(e));}finally{setBusy(false);}}
  useEffect(()=>{let disposed=false,stop=()=>{},stopVisibility=()=>{};let revision=-1;
    function accept(value:Content){if(disposed||value.revision<=revision)return;revision=value.revision;setContent(value);setSettings({...defaults,...value.settings});}
    void listen<Content>("visualizer-content",e=>accept(e.payload)).then(async f=>{if(disposed){f();return;}stop=f;accept(await invoke<Content>("get_visualizer"));}).catch(e=>setError(api.errorText(e)));
    void listen<boolean>("visualizer-visibility",e=>frame.current?.contentWindow?.postMessage({type:"converter-visibility",visible:e.payload},location.origin)).then(f=>{if(disposed)f();else stopVisibility=f;}).catch(e=>setError(api.errorText(e)));
    return()=>{disposed=true;stop();stopVisibility();};
  },[]);
  async function persistAppearance(value:Values){const latest=await converterRequest<Values>("/api/settings");await converterRequest("/api/settings",{...latest,...Object.fromEntries(Object.entries(value).filter(([key])=>visualizerSetting(key)))});}
  useEffect(()=>{const handler=(event:MessageEvent)=>{
    if(event.source!==frame.current?.contentWindow||event.origin!==location.origin)return;
    if(event.data?.type==="converter-visualizer-ready")void emit("visualizer-ready",{filename:event.data.filename,loaded:event.data.loaded});
    if(event.data?.type==="converter-settings-save"){const changed=Object.fromEntries(Object.entries(event.data.settings??{}).filter(([key])=>visualizerSetting(key)));setSettings(s=>({...s,...changed}));void persistAppearance(changed).catch(e=>setError(api.errorText(e)));}
    if(event.data?.type==="converter-fetch"){const {id,path,body}=event.data;const target=event.source as Window;void converterRequest(path,body).then(value=>target.postMessage({type:"converter-fetch-result",id,value},location.origin)).catch(e=>target.postMessage({type:"converter-fetch-result",id,error:api.errorText(e)},location.origin));}
  };window.addEventListener("message",handler);
    const visibility=()=>frame.current?.contentWindow?.postMessage({type:"converter-visibility",visible:!document.hidden},location.origin);
    const stop=()=>player.current?.postMessage({type:"converter-visibility",visible:false},location.origin);
    document.addEventListener("visibilitychange",visibility);window.addEventListener("beforeunload",stop);
    return()=>{window.removeEventListener("message",handler);document.removeEventListener("visibilitychange",visibility);window.removeEventListener("beforeunload",stop);};
  },[]);
  const sendVisualizer=()=>frame.current?.contentWindow?.postMessage({type:"converter-visualize",filename:selected,settings:settingsRef.current,assetRoot:convertFileSrc("/","converter")},location.origin);
  useEffect(()=>{if(player.current)sendVisualizer();},[content.revision]);
  function setting(key:string,value:unknown){setSettings(s=>({...s,[key]:value}));}
  const style=String(settings.visualizer_style??"classic");const scene=(settings.visualizer_scenes as Record<string,Values>??{})[style]??{};
  function sceneSetting(key:string,value:unknown){setting("visualizer_scenes",{...(settings.visualizer_scenes as Values??{}),[style]:{...scene,[key]:value}});}
  function chooseStyle(value:string){setting("visualizer_style",value);frame.current?.contentWindow?.postMessage({type:"converter-style",style:value},location.origin);}
  async function saveSettings(){await persistAppearance(settings);setMessage("Appearance saved. Reload visualization to apply advanced changes.");}
  const importSoundFont=()=>run(async()=>{const value=await dialog<{filename:string}|null>("converter_pick",{kind:"soundfont",device:null});if(value?.filename)frame.current?.contentWindow?.postMessage({type:"converter-soundfonts",filename:value.filename},location.origin);});
  return <div className="aux-window"><TitleBar label="Visualizer" onError={setError}/><div className="visualizer-window"><div className="section-heading"><h1>{selected.replace(/\.(mid|midi)$/i,"")||"Visualizer"}</h1><label className="toggle">Stay on top <input type="checkbox" checked={top} onChange={e=>{const value=e.target.checked;void invoke("overlay_options",{kind:"visualizer",top:value}).then(()=>setTop(value)).catch(e=>setError(api.errorText(e)));}}/></label></div>
      <section className="converter-player"><div className="button-row"><button disabled={busy||!selected} onClick={()=>void importSoundFont()}>Import .sf2</button><button disabled={!selected} onClick={sendVisualizer}>Reload visualization</button></div>
        {selected&&<iframe title="Piano visualizer" className="converter-visualizer" ref={frame} src="/converter/visualizer.html" onLoad={()=>{player.current=frame.current?.contentWindow??null;sendVisualizer();player.current?.postMessage({type:"converter-visibility",visible:!document.hidden},location.origin);}}/>}
        <details className="visualizer-appearance"><summary>Style & appearance</summary><h2>Piano style</h2><StylePreviews value={style} onChange={chooseStyle}/><div className="button-row"><button className="primary" disabled={busy} onClick={()=>void run(saveSettings)}>Save appearance</button><span className="help">Choose a preview to change the look.</span></div>
<button disabled={busy} onClick={()=>void run(async()=>{const value=await dialog<{url?:string;type?:string}|null>("converter_pick",{kind:"background",device:null});if(value?.url)setting("visualizer_scenes",{...(settings.visualizer_scenes as Values??{}),[style]:{...scene,mode:value.type??"image",media_type:value.type??"image",media_url:value.url}});})}>Add background</button>        <details><summary>Appearance and rendering</summary><div className="converter-options">
          {['hand_left_color','hand_right_color'].map(key=><label className="field" key={key}>{key.replaceAll('_',' ')}<input type="color" value={String(settings[key])} onChange={e=>setting(key,e.target.value)}/></label>)}<label className="field">Falling speed<input type="number" min="50" max="800" value={Number(settings.visualizer_speed)} onChange={e=>setting("visualizer_speed",+e.target.value)}/></label>
          {['visualizer_labels','visualizer_particles','download_hands'].map(key=><label className="toggle" key={key}><input type="checkbox" checked={!!settings[key]} onChange={e=>setting(key,e.target.checked)}/>{key.replaceAll('_',' ')}</label>)}
          <label className="field">Background<select value={String(scene.mode??"theme")} onChange={e=>sceneSetting("mode",e.target.value)}>{["theme","solid","spotlight","image","video"].map(v=><option key={v}>{v}</option>)}</select></label>
          <label className="field">Background color<input type="color" value={String(scene.color??"#172033")} onChange={e=>sceneSetting("color",e.target.value)}/></label>
          <label className="field">Effect<select value={String(scene.effect??"none")} onChange={e=>sceneSetting("effect",e.target.value)}>{["none","stars","waves","grid"].map(v=><option key={v}>{v}</option>)}</select></label>
          {([['dim','Background dim',80],['strength','Effect strength',100]] as const).map(([key,label,max])=><label className="field" key={key}>{label}<input type="range" min="0" max={max} value={Number(scene[key]??25)} onChange={e=>sceneSetting(key,+e.target.value)}/></label>)}
          <label className="field">Note colors<select value={String(settings.hand_color_mode)} onChange={e=>setting("hand_color_mode",e.target.value)}><option value="hands">Left / right hand</option><option value="tracks">Tracks</option></select></label>
        </div></details></details>
        </section>
{(error||message)&&<p role={error?"alert":"status"}>{error||message}</p>}</div></div>;
}
