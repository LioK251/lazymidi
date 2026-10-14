// @vitest-environment node
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {JSDOM} from "jsdom";
import {expect,it,vi} from "vitest";

function player(){
  const dom=new JSDOM(readFileSync("public/converter/visualizer.html","utf8"),{url:"http://localhost/converter/visualizer.html",pretendToBeVisual:true});
  const document=dom.window.document;
  document.getElementById("piano-visualizer-modal")!.classList.remove("hidden");
  const stack:number[]=[];
  const ctx:any=new Proxy({globalAlpha:1,save(){stack.push(this.globalAlpha);},restore(){this.globalAlpha=stack.pop()??1;},createLinearGradient:()=>({addColorStop(){}}),createRadialGradient:()=>({addColorStop(){}})}, {get(target:any,key){return key in target?target[key]:(target[key]=vi.fn());}});
  dom.window.HTMLCanvasElement.prototype.getContext=()=>ctx;
  document.querySelector(".pv-stage")!.getBoundingClientRect=()=>({width:1040,height:500} as DOMRect);
  let clock=1000;
  const settings:any={visualizer_style:"sketch",visualizer_particles:false,visualizer_scenes:{}};
  const reduced={matches:false};
  const images:any[]=[];
  class Image {tagName="IMG";naturalWidth=100;naturalHeight=100;src="";crossOrigin="";onerror=()=>{};onload=()=>{};constructor(){images.push(this);}}
  const window:any={devicePixelRatio:1,matchMedia:()=>reduced,addEventListener:dom.window.addEventListener.bind(dom.window),resolveVisualizerBackground:(path:string)=>path?.startsWith("/visualizer-backgrounds/")?"http://converter.localhost"+path:null};
  const context={window,document,Image,console,parent:{postMessage:vi.fn()},location:{origin:"http://localhost"},performance:{now:()=>clock},requestAnimationFrame:vi.fn(()=>1),cancelAnimationFrame:vi.fn(),loadSheetsSettingsSync:()=>settings,loadSheetsSettings:async()=>settings,saveSheetsSettings:vi.fn(),setTimeout,clearTimeout,setInterval,clearInterval};
  for(const file of ["piano-enhancements.js","piano-styles.js"])runInNewContext(readFileSync("public/converter/"+file,"utf8"),context);
  const artwork=window.PianoStyles;artwork.paper=vi.fn();
  const note=vi.spyOn(artwork,"note");const key=vi.spyOn(artwork,"keyboardDetail");
  // Exercise the actual render loop with a controlled clock and MIDI window, without starting audio.
  const source=readFileSync("public/converter/piano-visualizer.js","utf8").replace(/\}\)\(\);\s*$/,`window.testPlayer={status:toolStatus,render:renderFrame,stop:stopPlayback,setup(notes,time,paused=false){allNotes=notes;maxNoteDuration=10;totalDuration=30;handEstimates=Object.fromEntries(notes.map(n=>[n.id,n.hand]));pauseOffset=time;isPlaying=true;isPaused=paused;startTimeFallback=performance.now()/1000-time;},layout:()=>pianoKeyLayout};})();`);
  runInNewContext(source,context);
  return {dom,document,ctx,settings,artwork,note,window,status:window.testPlayer.status,key,reduced,images,render:window.testPlayer.render,setup:window.testPlayer.setup,stop:window.testPlayer.stop,layout:window.testPlayer.layout,advance:()=>{clock+=150;},close:()=>{window.testPlayer.status('');dom.window.close();}};
}
const notes=[{id:"l",midi:48,start:0,end:2,releaseEnd:5,velocity:0.8,track:0,piano:true,hand:"left"},{id:"r",midi:61,start:0,end:2,releaseEnd:5,velocity:0.8,track:1,piano:true,hand:"right"}];

it("keeps the playback slider precise between tenths of a second",()=>{
  const p=player();try{
    p.setup(notes,1.0123);p.render();
    const slider=p.document.getElementById("pv-seek") as HTMLInputElement;
    expect(slider.validity.stepMismatch).toBe(false);
    expect(Number(slider.value)).toBeCloseTo(1.0123,4);
  }finally{p.close();}
});
it.each([false,true])("coalesces scrub redraws and keeps the latest thumb position (paused=%s)",paused=>{
  const p=player();try{
    p.setup(notes,1,paused);p.render();p.note.mockClear();
    const slider=p.document.getElementById("pv-seek") as HTMLInputElement;
    for(let n=0;n<20;n++){
      slider.value=String(2+n*.0234);slider.dispatchEvent(new p.dom.window.Event("input"));
    }
    expect(p.note.mock.calls.length).toBeLessThanOrEqual(notes.length);
    const target=Number(slider.value);p.render();
    expect(Number(slider.value)).toBe(target);
    expect(parseFloat(slider.style.getPropertyValue("--seek-pct"))).toBeCloseTo(target/30*100,5);
    if(paused){slider.dispatchEvent(new p.dom.window.Event("change"));p.advance();p.render();expect(Number(slider.value)).toBe(target);}
  }finally{p.close();}
});

it.each(["hands","tracks"])("darkens black falling notes without altering the selected %s color",mode=>{
  const p=player();try{
    p.settings.hand_color_mode=mode;
    p.settings.hand_left_color="#38bdf8";
    p.setup([{...notes[0],midi:60},{...notes[0],id:"black",midi:61}],1);p.render();
    const white=p.note.mock.calls[0][6],black=p.note.mock.calls[1][6];
    expect(black).toEqual(white.map((v:number)=>Math.round(v*0.8)));
    expect(mode==="hands"?p.settings.hand_left_color:p.artwork.styles.sketch.colors[0]).toEqual(mode==="hands"?"#38bdf8":[51,81,117]);
  }finally{p.close();}
});

it("animates held drawn keys on the note clock, freezes on pause, and respects reduced motion",()=>{
  const p=player();try{
    p.setup(notes,1);p.render();
    const held=()=>p.key.mock.calls.find(c=>c[8]===48)!;
    const before=held()[7].time;p.key.mockClear();p.advance();p.render();
    expect(held()[7].time).toBeGreaterThan(before);
    p.setup(notes,1,true);p.key.mockClear();p.render();const paused=held()[7].time;
    p.key.mockClear();p.advance();p.render();expect(held()[7].time).toBe(paused);
    p.reduced.matches=true;p.key.mockClear();p.render();expect(held()[7]).toBeNull();
    expect(p.artwork.effectiveKeyboard("theme","sketch")).toBe("sketch");
    expect(p.artwork.keyColor([100,150,200],true)).toEqual([80,120,160]);
    p.reduced.matches=false;p.settings.visualizer_style='classic';p.settings.visualizer_scenes.classic={keyboard:'sketch'};
    p.dom.window.dispatchEvent(new p.dom.window.CustomEvent('piano-style-change',{detail:'classic'}));
    p.setup(notes,1);p.key.mockClear();p.advance();p.render();expect(held()[7].time).toBeGreaterThan(0);
  }finally{p.close();}
});
it("ghosts muted notes while retaining enabled-hand key ownership",()=>{
  const p=player();try{
    const alpha:number[]=[];const original=p.artwork.note;
    p.artwork.note=(...args:unknown[])=>{alpha.push(p.ctx.globalAlpha);return original(...args);};
    p.setup(notes,1);p.render();
    p.document.getElementById("pv-toggle-left")!.click();
    alpha.length=0;p.render();
    expect(alpha).toEqual([0.2,1]);
    const colors:string[]=[];const fill=p.ctx.fillRect;
    p.ctx.fillRect=(...args:unknown[])=>{colors.push(p.ctx.fillStyle);return fill(...args);};
    p.setup([{...notes[0],velocity:1},{...notes[1],midi:48,velocity:0.4}],1);p.render();
    expect(colors).toContain('rgba(244,114,182,0.63)');
  }finally{p.close();}
});

it("keeps video backgrounds still with reduced motion and reports rejected playback once",async()=>{
  const p=player();try{
    const play=vi.fn(async()=>{throw new Error('Playback denied');});
    p.dom.window.HTMLMediaElement.prototype.play=play;
    p.dom.window.HTMLMediaElement.prototype.pause=vi.fn();
    p.settings.visualizer_scenes.sketch={mode:'video',media_type:'video',media_url:'/visualizer-backgrounds/'+'a'.repeat(32)+'.mp4'};
    p.reduced.matches=true;p.render();expect(play).not.toHaveBeenCalled();
    p.reduced.matches=false;p.render();await Promise.resolve();await Promise.resolve();
    expect(p.document.getElementById('pv-tools-status')!.textContent).toContain('Could not play video background');
    p.render();expect(play).toHaveBeenCalledOnce();
  }finally{p.close();}
});
it("loads backgrounds through scoped native URLs and reports failures without hiding the piano",()=>{
  const p=player();try{
    p.settings.visualizer_scenes.sketch={mode:"image",media_type:"image",media_url:"/visualizer-backgrounds/"+"a".repeat(32)+".png"};
    p.render();expect(p.images[0].src).toContain("http://converter.localhost/visualizer-backgrounds/");expect(p.images[0].crossOrigin).toBe("anonymous");
    expect(p.ctx.drawImage).toHaveBeenCalled();
    p.images[0].naturalWidth=0;p.images[0].onerror();expect(p.document.getElementById("pv-tools-status")!.textContent).toContain("Could not load background");
    expect(p.key).toHaveBeenCalled();
  }finally{p.close();}
});
it('expires player notices without clearing a replacement or re-emitting failed media each frame',()=>{
  vi.useFakeTimers();const p=player();try{
    p.settings.visualizer_scenes.sketch={mode:'image',media_type:'image',media_url:'/visualizer-backgrounds/'+'a'.repeat(32)+'.png'};
    p.render();p.images[0].naturalWidth=0;p.images[0].onerror();
    vi.advanceTimersByTime(9000);p.render();expect(p.document.getElementById('pv-tools-status')!.textContent).toContain('Could not load background');
    vi.advanceTimersByTime(1000);p.render();expect(p.document.getElementById('pv-tools-status')!.textContent).toBe('');
    p.status('first');vi.advanceTimersByTime(9000);p.status('new');vi.advanceTimersByTime(1000);
    expect(p.document.getElementById('pv-tools-status')!.textContent).toBe('new');
    p.settings.visualizer_scenes.sketch={mode:'theme'};p.render();
    expect(p.document.getElementById('pv-tools-status')!.textContent).toBe('new');
    p.status('Rendering in real time.',true);vi.advanceTimersByTime(20000);
    expect(p.document.getElementById('pv-tools-status')!.textContent).toBe('Rendering in real time.');
  }finally{p.close();vi.useRealTimers();}
});
