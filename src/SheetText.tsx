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
function notes(text:string,color:string,key:number){
  const parts:ReactNode[]=[];let start=0;
  for(const match of text.matchAll(/:[^\s]/g)){
    parts.push(text.slice(start,match.index),<strong className="sheet-extended" title="Out-of-range note · Ctrl" key={match.index}>{match[0]}</strong>);
    start=match.index+match[0].length;
  }
  parts.push(text.slice(start));
  return <span className="sheet-chord" style={{color}} key={key}>{parts}</span>;
}
export function sheetLine(line:string,colored=true):ReactNode {
  if(!colored||!line.trim())return line;
  if(line.trim().startsWith("<!--"))return <span className="sheet-comment">{line}</span>;
  if(/^transpose by\b/i.test(line.trim()))return <strong className="sheet-transpose">{line}</strong>;
  if(/\s=\s/.test(line))return line;
  const parts:ReactNode[]=[];let start=0;let color=colors.long;
  for(const match of line.matchAll(separators)){
    if(match[0]==="-"&&line[match.index-1]===" ")continue;
    const end=match.index+match[0].length;color=tempo(match[0]);
    parts.push(notes(line.slice(start,end),color,start));start=end;
  }
  if(start<line.length)parts.push(notes(line.slice(start),color,start));
  return parts;
}
export function transposeValues(text:string){return [...text.matchAll(/^\s*Transpose by:\s*([+-]?\d+)/gmi)].map(m=>Number(m[1])).join(" ");}
export function transposeSequence(text:string):number[] {
  return text.split("\n").filter(line=>/^\s*Transpose by:/i.test(line)).map(line=>{
    const match=/^\s*Transpose by:\s*([+-]?\d+)\s*$/i.exec(line);
    if(!match)throw new Error("A transpose heading contains an invalid value.");
    return Number(match[1]);
  });
}

export function SheetText({text,colored=true,centered=false,zoom=1,lineAction,lineContent}:{text:string;colored?:boolean;centered?:boolean;zoom?:number;lineAction?:(index:number)=>ReactNode;lineContent?:(line:string,index:number)=>ReactNode}){
  const lines=text.split("\n");
  return <div className={`sheet-text${centered?" sheet-centered":""}`} style={{fontSize:18*zoom}} aria-label="Piano sheet">{lines.map((line,i)=><Fragment key={i}><div className="sheet-line"><span>{lineContent?.(line,i)??sheetLine(line,colored)}</span>{lineAction?.(i)}</div>{i<lines.length-1?"\n":null}</Fragment>)}</div>;
}

export function SheetTools({text,colored,onColored,centered,onCentered,zoom,onZoom,onError,children,onSendTransposes,hideLegend=false,busy=false}:{text:string;colored:boolean;onColored:(v:boolean)=>void;centered:boolean;onCentered:(v:boolean)=>void;zoom:number;onZoom:(v:number)=>void;onError:(message:string)=>void;children?:ReactNode;onSendTransposes?:(sequence:number[])=>Promise<void>;hideLegend?:boolean;busy?:boolean}){
  const transposes=transposeValues(text);
  async function copy(value:string){try{await navigator.clipboard.writeText(value);}catch{onError("Could not copy. Select the sheet text and copy it manually.");}}
  async function send(){try{await onSendTransposes?.(transposeSequence(text));}catch(error){onError(error instanceof Error?error.message:String(error));}}
  return <div className="sheet-tools" role="group" aria-label="Sheet view controls">
    <label><input type="checkbox" checked={colored} onChange={e=>onColored(e.target.checked)}/> Colors</label>
    <label><input type="checkbox" checked={centered} onChange={e=>onCentered(e.target.checked)}/> Center</label>
    <label>Zoom<input aria-label="Sheet zoom" type="range" min="0.5" max="3" step="0.1" value={zoom} onChange={e=>onZoom(+e.target.value)}/></label>
    <button disabled={!text} onClick={()=>void copy(text)}>Copy sheet</button><span className="sheet-transpose-tools"><button disabled={!transposes||busy} onClick={()=>void (onSendTransposes?send():copy(transposes))}>{onSendTransposes?"Send to Transposer":"Copy transposes"}</button>{children}</span>
    {!hideLegend&&<details className="sheet-legend"><summary>Tempo colors</summary><span style={{color:colors.sixteenth}}>- fast</span><span style={{color:colors.eighth}}>space</span><span style={{color:colors.quarter}}> - </span><span style={{color:colors.half}}>, </span><span style={{color:colors.whole}}>... pause</span><span style={{color:colors.long}}>| long pause</span><span><u>:key</u> Ctrl note</span></details>}
  </div>;
}
