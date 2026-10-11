import {expect,it,vi} from "vitest";
import {readFileSync} from "node:fs";
import {webcrypto} from "node:crypto";
import {resolve} from "node:path";
import {JSDOM} from "jsdom";
import {Midi} from "@tonejs/midi";

it("sends only player settings that changed so other-window drafts stay intact",async()=>{
  const dom=new JSDOM("",{url:"http://localhost",runScripts:"outside-only"});const w=dom.window;
  w.fetch=vi.fn();const nativeFetch=w.fetch;const post=vi.spyOn(w,"postMessage");
  try{
    w.eval(readFileSync(resolve("public/converter/bridge.js"),"utf8"));
    w.dispatchEvent(new w.MessageEvent("message",{source:w,origin:w.location.origin,data:{type:"converter-visualize",settings:{visualizer_speed:280,visualizer_soundfont:""},assetRoot:"/"}}));
    await w.saveSheetsSettings({visualizer_speed:280,visualizer_soundfont:"piano.sf2"});
    expect(post).toHaveBeenCalledWith({type:"converter-settings-save",settings:{visualizer_soundfont:"piano.sf2"}},w.location.origin);
    await w.fetch('/soundfonts/piano.sf2',{headers:{Range:'bytes=0-1023'}});
    expect(nativeFetch).toHaveBeenCalledWith('/soundfonts/piano.sf2',{headers:{Range:'bytes=0-1023'}});
  }finally{w.close();}
});

it("does not restart hidden animation when an asynchronous MIDI load finishes",async()=>{
  const source=name=>readFileSync(resolve("public/converter",name),"utf8");
  const dom=new JSDOM(source("visualizer.html"),{url:"http://localhost",runScripts:"outside-only"});
  const w=dom.window;
  const raf=vi.fn(()=>1);
  w.requestAnimationFrame=raf;w.cancelAnimationFrame=vi.fn();
  w.matchMedia=()=>({matches:false});
  w.HTMLCanvasElement.prototype.getContext=()=>({setTransform:()=>{}});
  Object.defineProperty(w.crypto,"subtle",{value:webcrypto.subtle});
  w.Midi=Midi;
  w.loadSheetsSettingsSync=()=>({visualizer_style:"classic"});
  w.loadSheetsSettings=async()=>({});
  w.saveSheetsSettings=vi.fn(async()=>{});
  w.AudioContext=class{constructor(){throw new Error("No audio device in this test");}};
  const audioError=vi.spyOn(w.console,"error").mockImplementation(()=>{});
  const midi=new Midi();midi.addTrack().addNote({midi:60,time:0,duration:1,velocity:0.7});
  w.fetch=async()=>({ok:true,json:async()=>({soundfonts:[]}),arrayBuffer:async()=>midi.toArray().buffer});
  let finishLibrary;
  w.MidiDownloads={ensureLibrary:()=>new Promise(resolve=>{finishLibrary=resolve;})};
  try{
    for(const file of ["piano-styles.js","piano-enhancements.js","piano-visualizer.js"])w.eval(source(file));
    const loading=w.openPianoVisualizer("test.mid");
    w.setVisualizerActive(false);
    finishLibrary();await loading;
    expect(w.document.getElementById("pv-export-hands").disabled).toBe(false);
    expect(raf).not.toHaveBeenCalled();
    w.setVisualizerActive(true);
    expect(raf).toHaveBeenCalledOnce();
    expect(audioError).toHaveBeenCalledWith("SoundFont load error:",expect.any(Error));
    w.fetch=async path=>{if(path==="/api/soundfonts")return {json:async()=>({soundfonts:[{filename:"piano.sf2",url:"/soundfonts/piano.sf2",size:1024}]})};throw new Error("Unavailable test asset");};
    await w.refreshPianoSoundFonts();
    expect(w.document.getElementById("pv-soundfont-select").value).toBe("builtin");
    await w.refreshPianoSoundFonts("/soundfonts/piano.sf2");
    await Promise.resolve();await Promise.resolve();
    expect(w.document.getElementById("pv-soundfont-select").value).toBe("/soundfonts/piano.sf2");
    expect(w.saveSheetsSettings).toHaveBeenCalledWith(expect.objectContaining({visualizer_soundfont:"/soundfonts/piano.sf2"}));
    w.fetch=async()=>{throw new Error("SoundFont list unavailable");};
    await w.refreshPianoSoundFonts();
    expect(w.document.getElementById("pv-soundfont-select").selectedOptions[0].textContent).toBe("Basic synth (fast)");
  }finally{dom.window.close();}
});

it("loads a selected SoundFont with bounded ranges and detects incomplete delivery",async()=>{
  const source=name=>readFileSync(resolve("public/converter",name),"utf8");
  const dom=new JSDOM(source("visualizer.html"),{url:"http://localhost",runScripts:"outside-only"});const w=dom.window;
  w.requestAnimationFrame=vi.fn(()=>1);w.cancelAnimationFrame=vi.fn();w.matchMedia=()=>({matches:false});
  w.HTMLCanvasElement.prototype.getContext=()=>({setTransform:()=>{}});Object.defineProperty(w.crypto,"subtle",{value:webcrypto.subtle});w.Midi=Midi;
  w.loadSheetsSettingsSync=()=>({visualizer_style:"classic"});w.loadSheetsSettings=async()=>({visualizer_soundfont:"/soundfonts/test.sf2"});w.saveSheetsSettings=vi.fn();w.MidiDownloads={ensureLibrary:async()=>{}};
  w.AudioContext=class {sampleRate=48000;createGain(){return {connect(){},gain:{value:1}};}};
  const load=vi.fn(async()=>1),unload=vi.fn();w.JSSynth={waitForReady:async()=>{},Synthesizer:class{init(){}setChannelType(){}createAudioNode(){return {connect(){}};}loadSFont=load;unloadSFont=unload;}};
  vi.spyOn(w.document.head,"appendChild").mockImplementation(node=>{queueMicrotask(()=>node.onload?.());return node;});
  const errors=vi.spyOn(w.console,"error").mockImplementation(()=>{});const total=8388640;let incomplete=false;
  const midi=new Midi();midi.addTrack().addNote({midi:60,time:0,duration:1,velocity:0.7});
  w.fetch=vi.fn(async(path,options)=>{
    if(path==="/api/soundfonts")return {json:async()=>({soundfonts:[{filename:"test.sf2",url:"/soundfonts/test.sf2",size:total}]})};
    if(path.startsWith("/api/midi/"))return {ok:true,arrayBuffer:async()=>midi.toArray().buffer};
    const range=options.headers.Range.match(/^bytes=(\d+)-(\d+)$/);const start=Number(range[1]),end=Math.min(Number(range[2]),total-1);
    return {ok:true,status:206,headers:{get:()=>`bytes ${start}-${end}/${total}`},arrayBuffer:async()=>new Uint8Array(end-start+1-(incomplete?1:0)).buffer};
  });
  try{
    for(const file of ["piano-styles.js","piano-enhancements.js","piano-visualizer.js"])w.eval(source(file));
    await w.openPianoVisualizer("test.mid");
    expect(w.fetch).toHaveBeenCalledWith("/soundfonts/test.sf2",{headers:{Range:"bytes=0-8388607"}});
    expect(w.fetch).toHaveBeenCalledWith("/soundfonts/test.sf2",{headers:{Range:"bytes=8388608-8388639"}});
    expect(load.mock.calls[0][0].byteLength).toBe(total);expect(errors).not.toHaveBeenCalled();
    incomplete=true;w.setVisualizerActive(false);w.setVisualizerActive(true);await w.openPianoVisualizer("second.mid");
    expect(load).toHaveBeenCalledOnce();
    expect(unload).not.toHaveBeenCalled();
    expect(w.fetch.mock.calls.filter(([path])=>path==="/soundfonts/test.sf2")).toHaveLength(2);
    await w.refreshPianoSoundFonts("/soundfonts/test.sf2");
    await new Promise(resolve=>setTimeout(resolve,0));
    // Force a different selection so the already-loaded font is fetched again.
    w.document.getElementById("pv-soundfont-select").value="builtin";w.document.getElementById("pv-soundfont-select").dispatchEvent(new w.Event("change"));
    await new Promise(resolve=>setTimeout(resolve,0));
    await w.refreshPianoSoundFonts("/soundfonts/test.sf2");await new Promise(resolve=>setTimeout(resolve,0));
    expect(errors).toHaveBeenCalledWith("SoundFont load error:",expect.objectContaining({message:"Incomplete SoundFont byte range."}));
    expect(w.document.getElementById("pv-export-hands").disabled).toBe(false);
  }finally{w.close();}
});

it("ignores an old MIDI response after a newer song has loaded",async()=>{
  const source=name=>readFileSync(resolve("public/converter",name),"utf8");
  const dom=new JSDOM(source("visualizer.html"),{url:"http://localhost",runScripts:"outside-only"});const w=dom.window;
  w.requestAnimationFrame=vi.fn(()=>1);w.cancelAnimationFrame=vi.fn();w.matchMedia=()=>({matches:false});
  w.HTMLCanvasElement.prototype.getContext=()=>({setTransform:()=>{}});Object.defineProperty(w.crypto,"subtle",{value:webcrypto.subtle});w.Midi=Midi;
  w.loadSheetsSettingsSync=()=>({visualizer_style:"classic"});w.loadSheetsSettings=async()=>({});w.saveSheetsSettings=vi.fn();w.MidiDownloads={ensureLibrary:async()=>{}};
  w.AudioContext=class{constructor(){throw new Error("No audio device in this test");}};vi.spyOn(w.console,"error").mockImplementation(()=>{});
  const parsed=vi.spyOn(w.console,"log");let finishOld,startedOld;const started=new Promise(resolve=>{startedOld=resolve;});
  const midi=new Midi();midi.addTrack().addNote({midi:60,time:0,duration:1,velocity:0.7});
  w.fetch=async path=>{if(path==="/api/soundfonts")return {json:async()=>({soundfonts:[]})};if(path.includes("old.mid")){startedOld();return new Promise(resolve=>{finishOld=resolve;});}return {ok:true,arrayBuffer:async()=>midi.toArray().buffer};};
  try{
    for(const file of ["piano-styles.js","piano-enhancements.js","piano-visualizer.js"])w.eval(source(file));
    const old=w.openPianoVisualizer("old.mid");await started;await w.openPianoVisualizer("new.mid");
    finishOld({ok:true,arrayBuffer:async()=>midi.toArray().buffer});await old;
    expect(parsed).toHaveBeenCalledOnce();expect(w.document.getElementById("pv-export-hands").disabled).toBe(false);
    expect(w.document.getElementById("pv-title").textContent).toContain("new");
  }finally{w.close();}
});
