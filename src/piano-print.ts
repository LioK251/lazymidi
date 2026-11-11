import {OpenSheetMusicDisplay} from "opensheetmusicdisplay";
import "./piano-score";

export async function printPiano(musicxml:string,title:string):Promise<void> {
  const previousTitle=document.title;
  const frame=document.createElement("iframe");
  frame.title="Printable piano score";
  frame.setAttribute("aria-hidden","true");
  frame.style.cssText="position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0";
  document.body.append(frame);
  let osmd:OpenSheetMusicDisplay|undefined;
  try{
    const doc=frame.contentDocument!,win=frame.contentWindow!;
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4 portrait;margin:0}html,body{margin:0;padding:0;background:white;color:black}body{width:210mm}div[id^="osmdCanvasPage"]{break-after:page;page-break-after:always;margin:0!important;width:210mm!important;height:297mm!important}div[id^="osmdCanvasPage"]:last-child{break-after:auto;page-break-after:auto}svg{display:block;width:210mm;height:297mm}</style></head><body><main></main></body></html>');
    doc.close();doc.title=title;
    osmd=new OpenSheetMusicDisplay(doc.querySelector("main")!,{backend:"svg",autoResize:false,pageFormat:"A4_P",
      drawTitle:true,drawComposer:false,drawSubtitle:true,drawLyricist:false,drawPartNames:false,drawMeasureNumbers:true});
    osmd.EngravingRules.AutoGenerateMultipleRestMeasuresFromRestMeasures=false;
    osmd.EngravingRules.TupletNumberLimitConsecutiveRepetitions=false;
    await osmd.load(musicxml);
    osmd.Zoom=.7;
    // Leave room for ledger notes and ties below the final staff on a page.
    osmd.EngravingRules.PageBottomMargin=10;
    const measure=document.createElement("canvas").getContext("2d")!;
    measure.font='28px "Times New Roman"';
    const lines=[""];
    for(const character of title.replace(/\s+/g," ").trim()){
      const line=lines.at(-1)!+character;
      if(measure.measureText(line).width<=690){lines[lines.length-1]=line;continue;}
      const space=line.lastIndexOf(" ");
      lines[lines.length-1]=space>0?line.slice(0,space):lines.at(-1)!;
      lines.push(space>0?line.slice(space+1):character);
    }
    osmd.EngravingRules.TitleTopDistance+=(lines.length-1)*osmd.EngravingRules.SheetTitleHeight;
    osmd.Sheet.TitleString=lines.join("\n");osmd.Sheet.SubtitleString="lazymidi";
    osmd.render();
    if(!doc.querySelector("svg"))throw new Error("No printable score was generated.");
    await doc.fonts?.ready;
    // Chromium uses the parent document's title for the PDF filename.
    document.title=title;
    await new Promise<void>((resolve,reject)=>{
      win.addEventListener("afterprint",()=>resolve(),{once:true});
      try{win.focus();win.print();}catch(error){reject(error);}
    });
  }finally{document.title=previousTitle;osmd?.clear();frame.remove();}
}
