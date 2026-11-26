import {useEffect,useState} from "react";
import type {ReactNode} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import * as api from "./backend";

export default function TitleBar({label,children,onClose,onError}:{label?:string;children?:ReactNode;onClose?:()=>void;onError:(message:string)=>void}) {
  const [maximized,setMaximized]=useState(false);
  const mac=/Mac/.test(navigator.platform);
  const action=(operation:()=>Promise<unknown>)=>{if(api.desktop)void operation().catch(e=>onError(api.errorText(e)));};
  useEffect(()=>{
    if(!api.desktop)return;
    const window=getCurrentWindow();let disposed=false,stop=()=>{};
    const update=()=>void window.isMaximized().then(value=>{if(!disposed)setMaximized(value);}).catch(()=>{});
    update();void window.onResized(update).then(unlisten=>{if(disposed)unlisten();else stop=unlisten;}).catch(()=>{});
    return()=>{disposed=true;stop();};
  },[]);
  return <header className={`titlebar ${mac?"mac":""}`}>
    <div className="drag-region" data-tauri-drag-region>
      <span className="brand" data-tauri-drag-region>lazymidi</span>{label&&<span className="window-label" data-tauri-drag-region title={label}>{label}</span>}
    </div>{children}
    {!mac&&<div className="window-controls">
      <button aria-label="Minimize window" onClick={()=>action(()=>getCurrentWindow().minimize())}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10"/></svg>
      </button>
      <button aria-label={maximized?"Restore window":"Maximize window"} onClick={()=>action(()=>getCurrentWindow().toggleMaximize())}>
        <svg viewBox="0 0 16 16" aria-hidden="true">{maximized?<path d="M5.5 5.5v-3h8v8h-3m-8-5h8v8h-8z"/>:<rect x="3" y="3" width="10" height="10"/>}</svg>
      </button>
      <button className="close" aria-label="Close window" onClick={()=>onClose?onClose():action(()=>getCurrentWindow().close())}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 3.5 9 9m0-9-9 9"/></svg>
      </button>
    </div>}
  </header>;
}
