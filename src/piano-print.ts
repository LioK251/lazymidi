import {OpenSheetMusicDisplay} from "opensheetmusicdisplay";
import "./piano-score";

export async function printPiano(musicxml:string,title:string):Promise<void> {
  const previousTitle=document.title;
  const paper=document.createElement("div"),style=document.createElement("style");
  paper.className="piano-print";paper.setAttribute("aria-hidden","true");
  style.dataset.pianoPrint="";
  style.textContent=`
    .piano-print{position:absolute;left:-10000px;top:0;width:210mm;margin:0;padding:0;background:white;color:black;color-scheme:light}
    .piano-print div[id^="osmdCanvasPage"]{break-after:page;page-break-after:always;margin:0!important;width:210mm!important;height:297mm!important}
    .piano-print div[id^="osmdCanvasPage"]:last-child{break-after:auto;page-break-after:auto}
    .piano-print svg{display:block;width:210mm;height:297mm}
    @media print{
      @page{size:A4 portrait;margin:0}
      html,body{margin:0!important;padding:0!important;width:210mm!important;height:auto!important;overflow:visible!important;background:white!important;color:black!important;color-scheme:light!important}
      body>:not(.piano-print){display:none!important}
      .piano-print{position:static;left:auto;top:auto}
    }`;
  document.head.append(style);document.body.append(paper);
  let osmd:OpenSheetMusicDisplay|undefined;
  try{
    const name=title.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g,"_").replace(/[. ]+$/,"").replace(/_lazymidi$/i,"")||"score";
    document.title=`${name}_lazymidi`;
    osmd=new OpenSheetMusicDisplay(paper,{backend:"svg",autoResize:false,pageFormat:"A4_P",
      drawTitle:true,drawComposer:false,drawSubtitle:true,drawLyricist:false,drawPartNames:false,drawMeasureNumbers:true});
    osmd.EngravingRules.AutoGenerateMultipleRestMeasuresFromRestMeasures=false;
    osmd.EngravingRules.TupletNumberLimitConsecutiveRepetitions=false;
    osmd.EngravingRules.VoiceSpacingMultiplierVexflow=1;
    await osmd.load(musicxml);
    osmd.Zoom=.7;
    // Leave room for tall beams, ledger notes and ties at the page edges.
    osmd.EngravingRules.PageTopMargin=10;
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
    if(!paper.querySelector("svg"))throw new Error("No printable score was generated.");
    await document.fonts?.ready;
    // Let the desktop webview receive the document title before opening its print UI.
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    await new Promise<void>((resolve,reject)=>{
      const done=()=>resolve();
      window.addEventListener("afterprint",done,{once:true});
      try{window.print();}catch(error){window.removeEventListener("afterprint",done);reject(error);}
    });
  }finally{document.title=previousTitle;osmd?.clear();paper.remove();style.remove();}
}
