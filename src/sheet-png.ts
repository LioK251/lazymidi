import {extendedNotes,sheetParts} from "./SheetText";

const width=2400;
const padding=64;
const lineHeight=67;
const stripHeight=8*lineHeight;
const maxPngBytes=32*1024*1024;
type Run={text:string;color:string;font:string;underline?:true;width:number};

const crcTable=Uint32Array.from({length:256},(_,index)=>{
  for(let bit=0;bit<8;bit++)index=(index>>>1)^((index&1)?0xedb88320:0);
  return index;
});

function chunk(type:string,data:Uint8Array=new Uint8Array(0)) {
  const bytes=new Uint8Array(data.length+12);
  const view=new DataView(bytes.buffer);
  view.setUint32(0,data.length);
  bytes.set(new TextEncoder().encode(type),4);
  bytes.set(data,8);
  let crc=0xffffffff;
  for(let i=4;i<bytes.length-4;i++)crc=crcTable[(crc^bytes[i])&255]^(crc>>>8);
  view.setUint32(bytes.length-4,crc^0xffffffff);
  return bytes;
}

export async function sheetPng(text:string,colored:boolean,centered:boolean):Promise<Blob> {
  const canvas=document.createElement("canvas");
  canvas.width=width;
  canvas.height=stripHeight;
  const ctx=canvas.getContext("2d",{alpha:false,willReadFrequently:true});
  if(!ctx)throw new Error("Could not create the sheet image.");
  await document.fonts.ready;
  const theme=getComputedStyle(document.documentElement);
  const foreground=theme.getPropertyValue("--text").trim()||"#e6e6e6";
  const background=theme.getPropertyValue("--surface").trim()||"#131313";
  const muted=theme.getPropertyValue("--muted").trim()||"#aaa";
  const maxLineWidth=width-2*padding;
  const rows:{runs:Run[];width:number}[]=[];

  for(const line of text.split(/\r?\n/)){
    let row:{runs:Run[];width:number}={runs:[],width:0};
    function append(run:Omit<Run,"width">,value:string,measured:number){
      if(row.width&&row.width+measured>maxLineWidth){rows.push(row);row={runs:[],width:0};}
      row.runs.push({...run,text:value,width:measured});
      row.width+=measured;
    }
    for(const part of sheetParts(line,colored)){
      for(const note of part.color?extendedNotes(part.text):[{text:part.text,extended:undefined}]){
        const color=part.color??(part.format==="comment"?muted:foreground);
        const style=note.extended?"900 ":part.format==="transpose"?"bold ":part.format==="comment"?"italic ":"";
        const font=`${style}36px Consolas, "Courier New", monospace`;
        const run={text:note.text,color,font,underline:note.extended};
        ctx.font=font;
        for(const word of note.text.replace(/\t/g,"        ").matchAll(/\S+|\s+/gu)){
          const value=word[0];
          const measured=ctx.measureText(value).width;
          if(measured<=maxLineWidth)append(run,value,measured);
          else for(const letter of value)append(run,letter,ctx.measureText(letter).width);
        }
      }
    }
    rows.push(row);
  }

  const height=2*padding+rows.length*lineHeight;
  const header=new Uint8Array(13);
  const dimensions=new DataView(header.buffer);
  dimensions.setUint32(0,width);
  dimensions.setUint32(4,height);
  header[8]=8;
  header[9]=2;
  ctx.textBaseline="middle";
  let top=0;
  const stride=width*3+1;
  // Encode scanlines from bounded canvases so the image can be taller than a single canvas.
  const strips=new ReadableStream<Uint8Array<ArrayBuffer>>({async pull(controller){
    if(top>=height){controller.close();return;}
    const size=Math.min(stripHeight,height-top);
    ctx.fillStyle=background;
    ctx.fillRect(0,0,width,size);
    const end=Math.min(rows.length,Math.ceil((top+size-padding)/lineHeight));
    for(let index=Math.max(0,Math.floor((top-padding)/lineHeight));index<end;index++){
      const row=rows[index];
      let x=centered?(width-row.width)/2:padding;
      const y=padding+index*lineHeight+lineHeight/2-top;
      for(const run of row.runs){
        ctx.font=run.font;
        ctx.fillStyle=run.color;
        ctx.fillText(run.text,x,y);
        if(run.underline)ctx.fillRect(x,y+20,run.width,3);
        x+=run.width;
      }
    }
    const rgba=ctx.getImageData(0,0,width,size).data;
    const data=new Uint8Array(size*stride);
    for(let source=0,y=0;y<size;y++){
      for(let destination=y*stride+1,x=0;x<width;x++){
        data[destination++]=rgba[source++];
        data[destination++]=rgba[source++];
        data[destination++]=rgba[source++];
        source++;
      }
    }
    top+=size;
    controller.enqueue(data);
    await new Promise(resolve=>setTimeout(resolve,0));
  }});
  const compressed=strips.pipeThrough(new CompressionStream("deflate")).getReader();
  const parts:BlobPart[]=[new Uint8Array([137,80,78,71,13,10,26,10]),chunk("IHDR",header)];
  let bytes=45;
  for(;;){
    const {value,done}=await compressed.read();
    if(done)break;
    bytes+=value.length+12;
    if(bytes>maxPngBytes){await compressed.cancel();throw new Error("The sheet PNG exceeds the 32 MiB export limit.");}
    parts.push(chunk("IDAT",value));
  }
  return new Blob([...parts,chunk("IEND")],{type:"image/png"});
}
