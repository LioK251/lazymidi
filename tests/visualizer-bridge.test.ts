import {expect,it,vi} from "vitest";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

function bridge(){
  let receive:(event:unknown)=>void=()=>{};
  const parent={postMessage:vi.fn()};
  const window={fetch:vi.fn(),addEventListener:vi.fn((_type,fn)=>{receive=fn;}),dispatchEvent:vi.fn(),openPianoVisualizer:vi.fn(async()=>{} )};
  const context={window,parent,location:{origin:"http://localhost"},CustomEvent,document:{getElementById:()=>({disabled:false})},Response,setTimeout,clearTimeout,alert:vi.fn()};
  runInNewContext(readFileSync("public/converter/bridge.js","utf8"),context);
  return {parent,window,context,send:(data:unknown,origin="http://localhost",source:unknown=parent)=>receive({data,origin,source})};
}
const path="/visualizer-backgrounds/"+"a".repeat(32)+".png";
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
