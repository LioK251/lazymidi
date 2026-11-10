import {expect,it,vi} from "vitest";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

function bridge(channels=new Set<any>()){
  let receive:(event:unknown)=>void=()=>{};
  const parent={postMessage:vi.fn()};
  const window={fetch:vi.fn(),addEventListener:vi.fn((type,fn)=>{if(type==='message')receive=fn;}),dispatchEvent:vi.fn(),openPianoVisualizer:vi.fn(async()=>{} ),refreshPianoSoundFonts:vi.fn(async()=>{}),seekPianoPlayback:vi.fn()};
  class BroadcastChannel {
    name:string;onmessage?: (event:{data:unknown})=>void;
    constructor(name:string){this.name=name;channels.add(this);}
    postMessage(data:unknown){for(const channel of channels)if(channel!==this&&channel.name===this.name)channel.onmessage?.({data});}
    close(){channels.delete(this);}
  }
  const context={window,parent,location:{origin:"http://localhost",search:""},URL,URLSearchParams,BroadcastChannel,CustomEvent,document:{getElementById:()=>({disabled:false})},Response,setTimeout,clearTimeout,alert:vi.fn()};
  runInNewContext(readFileSync("public/converter/bridge.js","utf8"),context);
  return {parent,window,context,send:(data:unknown,origin="http://localhost",source:unknown=parent)=>receive({data,origin,source})};
}
const path="/visualizer-backgrounds/"+"a".repeat(32)+".png";
it('seeks only the current score and accepts finite playback times from its parent',()=>{
  const b=bridge();b.send({type:'converter-visualize',revision:7,settings:{},assetRoot:'/'});
  b.send({type:'converter-seek',revision:7,time:5});
  expect(b.window.seekPianoPlayback).toHaveBeenCalledWith(5);
  b.send({type:'converter-seek',revision:6,time:8});
  b.send({type:'converter-seek',revision:7,time:Infinity});
  b.send({type:'converter-seek',revision:7,time:8},'https://foreign.example');
  expect(b.window.seekPianoPlayback).toHaveBeenCalledOnce();
});
it('shares the selected SoundFont between open viewers without reopening their MIDI or echoing settings',async()=>{
  const channels=new Set(),visualizer=bridge(channels),sheet=bridge(channels);
  for(const b of [visualizer,sheet])b.send({type:'converter-visualize',filename:'song.mid',settings:{visualizer_soundfont:'builtin'},assetRoot:'http://converter.localhost/%2F'});
  await runInNewContext("window.saveSheetsSettings({...window.loadSheetsSettingsSync(),visualizer_soundfont:'http://converter.localhost/%2Fsoundfonts/piano.sf2'})",visualizer.context);
  expect(runInNewContext('window.loadSheetsSettingsSync().visualizer_soundfont',sheet.context)).toBe('/soundfonts/piano.sf2');
  expect(sheet.window.refreshPianoSoundFonts).toHaveBeenCalledWith('http://converter.localhost/%2Fsoundfonts/piano.sf2');
  expect(sheet.window.openPianoVisualizer).toHaveBeenCalledOnce();
  sheet.parent.postMessage.mockClear();visualizer.parent.postMessage.mockClear();
  await runInNewContext("window.saveSheetsSettings({...window.loadSheetsSettingsSync(),visualizer_soundfont:'http://converter.localhost/%2Fsoundfonts/piano.sf2'})",sheet.context);
  expect(sheet.parent.postMessage).not.toHaveBeenCalled();expect(visualizer.parent.postMessage).not.toHaveBeenCalled();
});
it('resolves saved SoundFonts consistently and rejects files outside the SoundFont folder',()=>{
  const b=bridge();b.send({type:'converter-visualize',settings:{},assetRoot:'http://converter.localhost/%2F'});
  for(const value of ['/soundfonts/piano.sf2','http://converter.localhost/%2Fsoundfonts/piano.sf2','converter://localhost/soundfonts/piano.sf2']){
    expect(runInNewContext(`window.resolvePianoSoundFont(${JSON.stringify(value)})`,b.context)).toBe('http://converter.localhost/%2Fsoundfonts/piano.sf2');
  }
  for(const value of ['https://other.example/soundfonts/piano.sf2','/soundfonts/../settings.sf2','/soundfonts/%2e%2e%2fsettings.sf2','/soundfonts/piano.sf2?x=1']){
    expect(runInNewContext(`window.resolvePianoSoundFont(${JSON.stringify(value)})`,b.context)).toBeNull();
  }
});
it("discards the removed hands setting from legacy input and appearance saves",async()=>{
  const b=bridge();
  b.send({type:"converter-visualize",settings:{visualizer_hands:true,visualizer_particles:false},assetRoot:"http://converter.localhost/"});
  expect(runInNewContext("window.loadSheetsSettingsSync().visualizer_hands",b.context)).toBeUndefined();
  b.send({type:"converter-appearance",settings:{visualizer_hands:true,visualizer_labels:true}});
  await runInNewContext("window.saveSheetsSettings({...window.loadSheetsSettingsSync(),visualizer_hands:true,visualizer_particles:true})",b.context);
  expect(b.parent.postMessage).toHaveBeenLastCalledWith({type:"converter-settings-save",settings:{visualizer_particles:true}},"http://localhost");
});
it("keeps imported background paths canonical and resolves only scoped media",()=>{
  const b=bridge();
  b.send({type:"converter-visualize",settings:{visualizer_scenes:{classic:{media_url:path}}},assetRoot:"http://converter.localhost/"});
  expect(runInNewContext("window.loadSheetsSettingsSync().visualizer_scenes.classic.media_url",b.context)).toBe(path);
  expect(runInNewContext(`window.resolveVisualizerBackground(${JSON.stringify(path)})`,b.context)).toBe("http://converter.localhost"+path);
  for(const invalid of ["https://evil.example"+path,"//evil.example"+path,path+"?x=1","/visualizer-backgrounds/../settings.json",path.replace(".png","%2epng")]){
    expect(runInNewContext(`window.resolveVisualizerBackground(${JSON.stringify(invalid)})`,b.context)).toBeNull();
  }
});
it("previews appearance without reopening MIDI and ignores foreign messages",()=>{
  const b=bridge();
  b.send({type:"converter-visualize",filename:"song.mid",settings:{visualizer_scenes:{}},assetRoot:"http://converter.localhost/"});
  b.window.openPianoVisualizer.mockClear();
  b.send({type:"converter-appearance",settings:{visualizer_particles:true,visualizer_scenes:{classic:{media_url:"http://converter.localhost"+path}}}});
  expect(runInNewContext("window.loadSheetsSettingsSync().visualizer_particles",b.context)).toBe(true);
  expect(runInNewContext("window.loadSheetsSettingsSync().visualizer_scenes.classic.media_url",b.context)).toBe(path);
  expect(b.window.openPianoVisualizer).not.toHaveBeenCalled();
  b.send({type:"converter-appearance",settings:{visualizer_particles:false}},"https://evil.example");
  b.send({type:"converter-appearance",settings:{visualizer_particles:false}},"http://localhost",{});
  expect(runInNewContext("window.loadSheetsSettingsSync().visualizer_particles",b.context)).toBe(true);
});
