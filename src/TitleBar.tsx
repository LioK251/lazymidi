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
    <div className="drag-region" data-tauri-drag-region onDoubleClick={()=>action(()=>getCurrentWindow().toggleMaximize())}>
      <span className="brand" data-tauri-drag-region>lazymidi</span>{label&&<span className="window-label" data-tauri-drag-region>{label}</span>}
    </div>{children}
    {!mac&&<div className="window-controls">
      <button aria-label="Minimize window" onClick={()=>action(()=>getCurrentWindow().minimize())}>—</button>
      <button aria-label={maximized?"Restore window":"Maximize window"} onClick={()=>action(()=>getCurrentWindow().toggleMaximize())}>{maximized?"▱":"□"}</button>
      <button className="close" aria-label="Close window" onClick={()=>onClose?onClose():action(()=>getCurrentWindow().close())}>×</button>
    </div>}
  </header>;
}
