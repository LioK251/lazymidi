import {expect,it,vi} from "vitest";
import {readFileSync} from "node:fs";
import {JSDOM} from "jsdom";
import {displayName} from "../src/converter-api";

it.each([
  ["Song_transkun.mid","Song.mid","Song_lazymidi.mid"],
  ["曲_TRANSKUN_2_sheets.txt","曲_2_sheets.txt","曲_lazymidi_2_sheets.txt"],
  ["Song_transkun","Song","Song_lazymidi"],
  ["Song_transkun_remix.mid","Song_transkun_remix.mid","Song_transkun_remix.mid"],
  ["Original.mid","Original.mid","Original.mid"],
])("formats %s without changing the source ID",(source,display,download)=>{
  expect(displayName(source)).toBe(display);
  expect(window.ConverterNames.download(source)).toBe(download);
});
it.each([false,true])("brands visualizer MIDI downloads while preserving hand split=%s",split=>{
  const dom=new JSDOM("",{url:"http://localhost",runScripts:"outside-only"});const w=dom.window as Window&typeof globalThis;
  const data=new Uint8Array([1,2,3]);const encode=vi.fn(()=>data),hands={left:1};
  Object.assign(w,{PianoEnhancements:{encodeMidi:encode,splitHands:(_midi:unknown,value:unknown)=>value}});
  w.URL.createObjectURL=vi.fn(()=>"blob:test");w.URL.revokeObjectURL=vi.fn();
  const click=vi.spyOn(w.HTMLAnchorElement.prototype,"click").mockImplementation(function(this:HTMLAnchorElement){
    expect(this.download).toBe(split?"Song_lazymidi_2_hands.mid":"Song_lazymidi_2.mid");
  });
  try{
    for(const file of ["file-names.js","midi-downloads.js"])w.eval(readFileSync("public/converter/"+file,"utf8"));
    (w as unknown as {MidiDownloads:{save:Function}}).MidiDownloads.save(data,null,hands,"Song_transkun_2.mid",split);
    expect(click).toHaveBeenCalledOnce();
    expect(encode).toHaveBeenCalledTimes(split?1:0);
    if(split)expect(encode).toHaveBeenCalledWith(hands);
  }finally{w.close();}
});
