// @vitest-environment node
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {JSDOM} from "jsdom";
import {expect,it,vi} from "vitest";

function worker(paired=true){
  const stored:Record<string,unknown>=paired?{serverUrl:"http://127.0.0.1:1234",token:"paired-token"}:{};
  let message:(request:unknown,sender:unknown,reply:(value:unknown)=>void)=>boolean;
  let installed:()=>void;
  let clicked:(info:unknown)=>Promise<void>;
  const fetch=vi.fn(async()=>({ok:true,status:202,json:async()=>({task_id:"job-id"})}));
  const create=vi.fn();const badge=vi.fn();
  const chrome={storage:{session:{get:async()=>stored,set:async(value:object)=>Object.assign(stored,value)}},
    runtime:{onMessage:{addListener:(fn:typeof message)=>message=fn},onInstalled:{addListener:(fn:typeof installed)=>installed=fn}},
    contextMenus:{removeAll:(done:()=>void)=>done(),create,onClicked:{addListener:(fn:typeof clicked)=>clicked=fn}},
    action:{setBadgeText:badge}};
  runInNewContext(readFileSync(new URL("../extension/background.js",import.meta.url),"utf8"),{chrome,fetch,URL,AbortController,setTimeout,clearTimeout,atob,FormData,Blob,Uint8Array});
  return {fetch,stored,create,badge,installed:()=>installed(),click:(info:unknown)=>clicked(info),
    send:(request:unknown)=>new Promise<Record<string,any>>(resolve=>message(request,{},resolve))};
}
it.each(["https://www.youtube.com/watch?v=abc","https://www.tiktok.com/@piano/video/123"])("submits %s with paired authentication and the service compute preference",async url=>{
  const w=worker();expect(await w.send({action:"startConvert",url})).toMatchObject({success:true,task_id:"job-id"});
  const [endpoint,options]=w.fetch.mock.calls[0] as unknown as [string,RequestInit];
  expect(endpoint).toBe("http://127.0.0.1:1234/api/convert");
  expect(options.headers).toMatchObject({"X-Lazymidi-Token":"paired-token"});
  expect(JSON.parse(String(options.body))).toEqual({media_url:url});
});
it("adds Discord media actions and preserves signed attachment queries",async()=>{
  const w=worker();w.installed();expect(w.create).toHaveBeenCalledWith(expect.objectContaining({contexts:["link","audio","video"]}));
  const url="https://cdn.discordapp.com/attachments/123/456/piano.mp3?ex=deadbeef&is=123&hm=signature";
  await w.click({menuItemId:"lazymidi-discord",linkUrl:url});
  expect(JSON.parse(String((w.fetch.mock.calls[0] as unknown as [string,RequestInit])[1].body))).toEqual({media_url:url});
  expect(w.stored.lastJobId).toBe("job-id");expect(w.badge).toHaveBeenCalledWith({text:"…"});
});
it.each(["https://cdn.discordapp.com.evil.test/attachments/123/456/a.mp3","https://cdn.discordapp.com/attachments/123/456/a.exe","http://127.0.0.1/a.mp3","https://discord.com/channels/123/456","https://user:pass@youtube.com/watch?v=a"])("rejects invalid media %s",async url=>{
  const w=worker();expect(await w.send({action:"startConvert",url})).toMatchObject({success:false});expect(w.fetch).not.toHaveBeenCalled();
});
it("keeps unpaired requests local and reports Discord submission failures in the popup state",async()=>{
  const w=worker(false);expect(await w.send({action:"startConvert",url:"https://youtu.be/abc"})).toMatchObject({success:false,error:expect.stringContaining("Pair")});
  expect(w.fetch).not.toHaveBeenCalled();
  await w.click({menuItemId:"lazymidi-discord",srcUrl:"https://media.discordapp.net/attachments/123/456/a.webm"});
  expect(w.stored.jobError).toContain("Pair");expect(w.badge).toHaveBeenCalledWith({text:"!"});
});
it("imports a downloaded MuseScore MIDI with scoped credentials and rejects invalid files",async()=>{
  const w=worker();w.fetch.mockResolvedValue({ok:true,status:200,json:async()=>({success:true,midi_name:"score.mid"})} as never);
  expect(await w.send({action:"importMidi",data:btoa("MThdtest"),filename:"score.mid",sourceUrl:"https://musescore.com/user/1/scores/123"})).toMatchObject({success:true,midi_name:"score.mid"});
  const [endpoint,options]=w.fetch.mock.calls[0] as unknown as [string,RequestInit];
  expect(endpoint).toBe("http://127.0.0.1:1234/api/import-midi");expect((options.body as FormData).get("source")).toBe("musescore");
  w.fetch.mockClear();expect(await w.send({action:"importMidi",data:btoa("invalid")})).toMatchObject({success:false});expect(w.fetch).not.toHaveBeenCalled();
});
it.each([false,true])("shows browser conversion status or errors in the popup (error=%s)",async failed=>{
  const dom=new JSDOM(readFileSync(new URL("../extension/popup.html",import.meta.url),"utf8"));
  const sendMessage=vi.fn(async()=>({success:true,data:{status:"completed",midi_name:"piano.mid"}}));
  const badge=vi.fn();
  const chrome={storage:{session:{get:async()=>({serverUrl:"http://127.0.0.1:1234",token:"token",lastJobId:"job-id",jobError:failed?"Converter is unavailable":""})}},runtime:{sendMessage},action:{setBadgeText:badge}};
  try{
    runInNewContext(readFileSync(new URL("../extension/popup.js",import.meta.url),"utf8"),{chrome,document:dom.window.document,window:dom.window,setTimeout:vi.fn(),clearTimeout:vi.fn()});
    await vi.waitFor(()=>expect(dom.window.document.getElementById("job")?.textContent).toBe(failed?"Converter is unavailable":"piano.mid"));
    expect((dom.window.document.getElementById("endpoint") as HTMLInputElement).value).toBe("http://127.0.0.1:1234");
    expect(sendMessage).toHaveBeenCalledTimes(failed?0:1);expect(badge).toHaveBeenCalledWith({text:""});
  }finally{dom.window.close();}
});
