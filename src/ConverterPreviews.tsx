import {useEffect,useRef,useState} from "react";
import {convertFileSrc} from "@tauri-apps/api/core";
import "../public/converter/piano-styles.js";

function PianoPreview({style}:{style:string}) {
  const canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    if(canvas.current&&typeof CanvasRenderingContext2D!=="undefined")window.PianoStyles.preview(canvas.current,style);
  },[style]);
  return <canvas ref={canvas} width={640} height={280} aria-hidden="true"/>;
}

export function StylePreviews({value,onChange}:{value:string;onChange:(style:string)=>void}) {
  return <div className="style-previews" role="group" aria-label="Piano style previews">
    {Object.entries(window.PianoStyles.styles).map(([id,style])=><button key={id}
      aria-label={`${style.name} style preview`} aria-pressed={value===id} onClick={()=>onChange(id)}>
      <PianoPreview style={id}/><span>{style.name}</span><small>{style.description}</small>
    </button>)}
  </div>;
}

export function thumbnailSrc(value:string|undefined):string|undefined {
  if(!value)return;
  const local=value.match(/^\/converted\/([^/\\:?#]+\.(?:png|jpe?g|webp|gif))$/i);
  if(local)return convertFileSrc(`converted/${local[1]}`,"converter");
  try {
    const url=new URL(value);
    if(url.protocol==="https:"&&["img.youtube.com","i.ytimg.com"].includes(url.hostname)
      &&/^\/vi(?:_webp)?\/[\w-]+\/[\w.-]+\.(jpg|webp)$/.test(url.pathname)
      &&!url.username&&!url.password&&!url.port)return url.href;
  }catch{/* Imported metadata may have no usable artwork. */}
}

export function SongPreview({title,thumbnail,onClick,disabled=false}:{title:string;thumbnail?:string;onClick:()=>void;disabled?:boolean}) {
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[thumbnail]);
  const src=failed?undefined:thumbnailSrc(thumbnail);
  return <button className="song-preview" aria-label={`Preview ${title}`} onClick={onClick} disabled={disabled}>
    {src?<img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:<PianoPreview style="classic"/>}
    <span>Preview piano</span>
  </button>;
}
