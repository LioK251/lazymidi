import {invoke} from "@tauri-apps/api/core";
import {useEffect,useRef,useState} from "react";
import * as api from "./backend";

let startupCheck:Promise<string|null>|undefined;

export default function UpdateNotice(){
  const dialog=useRef<HTMLDialogElement>(null);
  const [version,setVersion]=useState<string|null>(null);
  const [opening,setOpening]=useState(false);
  const [error,setError]=useState("");

  useEffect(()=>{
    if(!api.desktop)return;
    let live=true;
    startupCheck??=invoke<string|null>("check_for_update").catch(()=>null);
    void startupCheck.then(value=>{
      if(live&&typeof value==="string"&&/^\d+\.\d+\.\d+$/.test(value))setVersion(value);
    });
    return()=>{live=false;};
  },[]);

  useEffect(()=>{
    const popup=dialog.current;
    if(!version||!popup)return;
    const key=`lazymidi.update-seen.${version}`;
    try{if(localStorage.getItem(key)){setVersion(null);return;}}
    catch{setVersion(null);return;}
    let live=true;
    const reason=Symbol("update notice");
    void api.pauseOutput(reason,true).then(()=>{
      if(!live)return;
      if(localStorage.getItem(key)){setVersion(null);return;}
      localStorage.setItem(key,"1");
      popup.showModal();
    }).catch(()=>{if(live)setVersion(null);});
    return()=>{
      live=false;
      if(popup.open)popup.close();
      void api.pauseOutput(reason,false).catch(()=>{});
    };
  },[version]);

  async function viewRelease(){
    setOpening(true);
    setError("");
    try{await invoke("open_update_release",{version});dialog.current?.close();}
    catch{setError("Could not open the release page.");}
    finally{setOpening(false);}
  }

  return version&&<dialog ref={dialog} className="update-notice" aria-labelledby="update-title" onClose={()=>setVersion(null)}>
    <h2 id="update-title">Update available</h2>
    <p>lazymidi {version} is ready to download.</p>
    <div className="button-row">
      <button className="primary" disabled={opening} onClick={()=>void viewRelease()}>View release</button>
      <button autoFocus onClick={()=>dialog.current?.close()}>Dismiss</button>
    </div>
    {error&&<p role="alert">{error}</p>}
  </dialog>;
}
