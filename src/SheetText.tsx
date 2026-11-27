import {Fragment} from "react";
import type {ReactNode} from "react";

// Tempo grouping and colors adapted from mp3converter's MIT sheets-utils.js.
const colors={long:"#a3f0a3",whole:"#74da74",half:"#9ada5a",quarter:"#c0c05a",eighth:"#da7e5a",sixteenth:"#daa6a6"};
const separators=/\.{3,} ?|[|¦–—‒―] ?| - |, |-| /g;
function tempo(separator:string){
  if(separator[0]===".")return separator.trim().length>=5?colors.long:colors.whole;
  if("|¦".includes(separator[0]))return colors.long;
  if("–—‒―".includes(separator[0])||separator===" - ")return colors.quarter;
  return separator===", "?colors.half:separator===" "?colors.eighth:colors.sixteenth;
}
export function extendedNotes(text:string){
  const parts:{text:string; extended?:true}[]=[];let start=0;
  for(const match of text.matchAll(/:[^\s]/g)){
    if(match.index>start)parts.push({text:text.slice(start,match.index)});
    parts.push({text:match[0],extended:true});
    start=match.index+match[0].length;
  }
  if(start<text.length)parts.push({text:text.slice(start)});
  return parts;
}
export function sheetParts(line:string,colored:boolean):{text:string;color?:string;format?:"comment"|"transpose"}[] {
  if(!colored||!line.trim())return [{text:line}];
  if(line.trim().startsWith("<!--"))return [{text:line,format:"comment"}];
  if(/^transpose by\b/i.test(line.trim()))return [{text:line,format:"transpose"}];
  if(/\s=\s/.test(line))return [{text:line}];
  const parts:{text:string;color:string}[]=[];let start=0;let color=colors.long;
  for(const match of line.matchAll(separators)){
    if(match[0]==="-"&&line[match.index-1]===" ")continue;
    const end=match.index+match[0].length;color=tempo(match[0]);
    parts.push({text:line.slice(start,end),color});start=end;
  }
  if(start<line.length)parts.push({text:line.slice(start),color});
  return parts;
}
export function sheetLine(line:string,colored=true):ReactNode {
  return sheetParts(line,colored).map(({text,color,format},index)=>{
    if(format==="comment")return <span className="sheet-comment" key={index}>{text}</span>;
    if(format==="transpose")return <strong className="sheet-transpose" key={index}>{text}</strong>;
    if(!color)return text;
    return <span className="sheet-chord" style={{color}} key={index}>{extendedNotes(text).map((note,i)=>note.extended?
      <strong className="sheet-extended" title="Out-of-range note · Ctrl" key={i}>{note.text}</strong>:note.text)}</span>;
  });
}
export function transposeValues(text:string){return [...text.matchAll(/^\s*Transpose by:\s*([+-]?\d+)/gmi)].map(m=>Number(m[1])).join(" ");}
export function transposeSequence(text:string):number[] {
  return text.split("\n").filter(line=>/^\s*Transpose by:/i.test(line)).map(line=>{
    const match=/^\s*Transpose by:\s*([+-]?\d+)(?:\s+\([+-]\d+\))?\s*$/i.exec(line);
    if(!match)throw new Error("A transpose heading contains an invalid value.");
    return Number(match[1]);
  });
}

export function SheetText({text,colored=true,centered=false,zoom=1,lineAction,lineContent}:{text:string;colored?:boolean;centered?:boolean;zoom?:number;lineAction?:(index:number)=>ReactNode;lineContent?:(line:string,index:number)=>ReactNode}){
  const lines=text.split("\n");
  return <div className={`sheet-text${centered?" sheet-centered":""}`} style={{fontSize:18*zoom}} aria-label="Piano sheet">{lines.map((line,i)=><Fragment key={i}><div className="sheet-line"><span>{lineContent?.(line,i)??sheetLine(line,colored)}</span>{lineAction?.(i)}</div>{i<lines.length-1?"\n":null}</Fragment>)}</div>;
}

export function SheetTools({text,colored,onColored,centered,onCentered,zoom,onZoom,onError,children,onSendTransposes,showCopyTransposes=false,hideLegend=false,busy=false,onOpen,onExport,exporting=false,viewOptions,image=false}:{text:string;colored:boolean;onColored:(v:boolean)=>void;centered:boolean;onCentered:(v:boolean)=>void;zoom:number;onZoom:(v:number)=>void;onError:(message:string)=>void;children?:ReactNode;onSendTransposes?:(sequence:number[])=>Promise<void>;showCopyTransposes?:boolean;hideLegend?:boolean;busy?:boolean;onOpen?:()=>void;onExport?:()=>void;exporting?:boolean;viewOptions?:ReactNode;image?:boolean}){
  const transposes=transposeValues(text);
  async function copy(value:string){try{await navigator.clipboard.writeText(value);}catch{onError("Could not copy. Select the sheet text and copy it manually.");}}
  async function send(){try{await onSendTransposes?.(transposeSequence(text));}catch(error){onError(error instanceof Error?error.message:String(error));}}
  const viewControls=<>{viewOptions}
    <label><input type="checkbox" disabled={image} checked={colored} onChange={e=>onColored(e.target.checked)}/> Colors</label>
    <label><input type="checkbox" disabled={image} checked={centered} onChange={e=>onCentered(e.target.checked)}/> Center</label>
    <label>Zoom<input aria-label="Sheet zoom" type="range" min="0.5" max="3" step="0.1" value={zoom} onChange={e=>onZoom(+e.target.value)}/></label>
  </>;
  return <div className={`sheet-tools${onOpen?" sheet-toolbar":""}`} role="group" aria-label="Sheet view controls">
    {onOpen?<button className="sheet-file-action" onClick={onOpen}>Open</button>:viewControls}
    <button className="sheet-file-action" disabled={!text} onClick={()=>void copy(text)}>{onOpen?"Copy":"Copy sheet"}</button>
    {onExport&&<button className="sheet-file-action" title="Save the full sheet as a PNG" disabled={!text.trim()||image||busy||exporting} aria-busy={exporting} onClick={onExport}>{exporting?"Exporting…":"Export"}</button>}
    {onSendTransposes&&<button className="sheet-file-action" title="Send the sequence to Float monitor" disabled={!transposes||busy} onClick={()=>void send()}>Transposer</button>}
    <span className="sheet-transpose-tools">
      {children}
      {(!onSendTransposes||showCopyTransposes)&&<button disabled={!transposes||busy} onClick={()=>void copy(transposes)}>Copy Transposes</button>}
    </span>
    {onOpen&&<details className="sheet-view-options" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.open=false;}} onKeyDown={e=>{if(e.key==="Escape"){e.currentTarget.open=false;e.currentTarget.querySelector("summary")?.focus();e.stopPropagation();}}}><summary>View</summary><div className="sheet-view-panel" role="group" aria-label="Sheet appearance">{viewControls}</div></details>}
    {!hideLegend&&<details className="sheet-legend"><summary>Tempo colors</summary><span style={{color:colors.sixteenth}}>- fast</span><span style={{color:colors.eighth}}>space</span><span style={{color:colors.quarter}}> - </span><span style={{color:colors.half}}>, </span><span style={{color:colors.whole}}>... pause</span><span style={{color:colors.long}}>| long pause</span><span><u>:key</u> Ctrl note</span></details>}
  </div>;
}
