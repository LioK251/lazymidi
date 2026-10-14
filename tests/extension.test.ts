// @vitest-environment node
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {createContext,runInContext,runInNewContext} from "node:vm";
import {JSDOM} from "jsdom";
import {expect,it,vi} from "vitest";

it("keeps stale page buttons hidden until the current extension confirms app health",()=>{
  const dom=new JSDOM('<!doctype html><head><style id="audioconverter-glass-style">.ac-glass-btn {display:inline-flex!important}</style></head><body></body>');
  try{
    runInNewContext(readFileSync("extension/glass-button.js","utf8"),{document:dom.window.document});
    const stale=dom.window.document.createElement("button");stale.className="ac-glass-btn";dom.window.document.body.append(stale);
    expect(dom.window.getComputedStyle(stale).display).toBe("none");
    stale.dataset.lazymidiOnline="true";
    expect(dom.window.getComputedStyle(stale).display).toBe("inline-flex");
    stale.dataset.lazymidiOnline="false";
    expect(dom.window.getComputedStyle(stale).display).toBe("none");
  }finally{dom.window.close();}
});

it.each([
  ["youtube.js","https://www.youtube.com/watch?v=abc","audioconverter-convert-btn"],
  ["youtube.js","https://www.tiktok.com/@piano/video/123","audioconverter-convert-btn"],
  ["musescore.js","https://musescore.com/user/1/scores/123","audioconverter-ms-btn"],
])("shows %s controls only while lazymidi is reachable on %s",async(script,url,id)=>{
  const dom=new JSDOM("<!doctype html><body></body>",{url});
  let alive=false;const ticks:(()=>unknown)[]=[];
  try{
    runInNewContext(readFileSync(new URL(`../extension/${script}`,import.meta.url),"utf8"),{
      document:dom.window.document,location:dom.window.location,URLSearchParams,
      chrome:{runtime:{sendMessage:(_request:unknown,reply?:(response:unknown)=>void)=>{const response={success:true,alive};reply?.(response);return Promise.resolve(response);}}},
      acCreateGlassButton:(id:string,label:string)=>{const button=dom.window.document.createElement("button");button.id=id;button.textContent=label;return button;},acSetGlassState:vi.fn(),
      setInterval:vi.fn((fn:()=>unknown)=>{ticks.push(fn);}),clearInterval:vi.fn(),setTimeout:vi.fn(),clearTimeout:vi.fn(),console,
    });
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    await vi.waitFor(()=>expect(ticks.length).toBeGreaterThan(0));
    await new Promise(resolve=>setImmediate(resolve));
    expect(dom.window.document.getElementById(id)).toBeNull();
    alive=true;ticks.forEach(fn=>fn());
    await vi.waitFor(()=>expect(dom.window.document.getElementById(id)).not.toBeNull());
    alive=false;ticks.forEach(fn=>fn());
    await vi.waitFor(()=>expect(dom.window.document.getElementById(id)).toBeNull());
    alive=true;ticks.forEach(fn=>fn());
    await vi.waitFor(()=>expect(dom.window.document.querySelectorAll(`#${id}`)).toHaveLength(1));
  }finally{dom.window.close();}
});
it("can reinject controls without duplicate buttons or active page timers",async()=>{
  const dom=new JSDOM("<!doctype html><body></body>",{url:"https://www.youtube.com/watch?v=abc"});
  const clear=vi.fn();
  const context=createContext({document:dom.window.document,location:dom.window.location,URLSearchParams,
    chrome:{runtime:{sendMessage:async()=>({success:true,alive:true})}},
    setInterval:vi.fn(()=>1),clearInterval:clear,setTimeout,clearTimeout,console});
  try{
    for(let n=0;n<2;n++){
      for(const script of ["glass-button.js","youtube.js"])runInContext(readFileSync(new URL(`../extension/${script}`,import.meta.url),"utf8"),context);
      dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
      await vi.waitFor(()=>expect(dom.window.document.querySelectorAll("#audioconverter-convert-btn")).toHaveLength(1));
    }
    expect(clear).toHaveBeenCalled();
  }finally{runInContext("globalThis.lazymidiVideoCleanup?.()",context);dom.window.close();}
});

it("automatically discovers the converter with an empty browser session",async()=>{
  const w=worker(false);
  w.fetch.mockImplementation(async()=>({ok:true,status:200,json:async()=>({application:"lazymidi-converter",protocol:1,token:"automatic-extension-token",status:"ok"})}) as never);
  expect(await w.send({action:"ping"})).toMatchObject({success:true,alive:true});
});

function worker(online=true){
  const stored:Record<string,unknown>={};
  let message:(request:unknown,sender:unknown,reply:(value:unknown)=>void)=>boolean;
  let installed:()=>void;
  let clicked:(info:unknown)=>Promise<void>;
  const fetch=vi.fn(async(endpoint:string)=>{
    if(!online)throw new Error("Failed to fetch");
    const payload=endpoint.endsWith("/api/extension-connect")?{application:"lazymidi-converter",protocol:1,token:"automatic-extension-token"}:endpoint.endsWith("/api/extension-health")?{status:"ok"}:endpoint.endsWith("/api/import-midi")?{success:true,midi_name:"score.mid"}:{task_id:"job-id"};
    return {ok:true,status:200,json:async()=>payload};
  });
  const create=vi.fn();const badge=vi.fn();
  const inject=vi.fn(async()=>[]);
  const chrome={storage:{session:{get:async()=>stored,set:async(value:object)=>Object.assign(stored,value)}},
    runtime:{getManifest:()=>({content_scripts:[{matches:["https://www.youtube.com/*"],js:["glass-button.js","youtube.js"]}]}),onMessage:{addListener:(fn:typeof message)=>message=fn},onInstalled:{addListener:(fn:typeof installed)=>installed=fn}},
    tabs:{query:async()=>[{id:42}]},scripting:{executeScript:inject},
    contextMenus:{removeAll:(done:()=>void)=>done(),create,onClicked:{addListener:(fn:typeof clicked)=>clicked=fn}},
    action:{setBadgeText:badge}};
  runInNewContext(readFileSync(new URL("../extension/background.js",import.meta.url),"utf8"),{chrome,fetch,URL,AbortController,setTimeout,clearTimeout,atob,FormData,Blob,Uint8Array});
  return {fetch,stored,create,badge,inject,installed:()=>installed(),click:(info:unknown)=>clicked(info),
    send:(request:unknown)=>new Promise<Record<string,any>>(resolve=>message(request,{},resolve))};
}
it.each(["https://www.youtube.com/watch?v=abc","https://www.tiktok.com/@piano/video/123"])("submits %s with automatic authentication and the service compute preference",async url=>{
  const w=worker();expect(await w.send({action:"startConvert",url})).toMatchObject({success:true,task_id:"job-id"});
  const [endpoint,options]=w.fetch.mock.calls.find(([endpoint])=>endpoint.endsWith("/api/convert")) as unknown as [string,RequestInit];
  expect(endpoint).toBe("http://127.0.0.1:27653/api/convert");
  expect(options.headers).toMatchObject({"X-Lazymidi-Token":"automatic-extension-token"});
  expect(JSON.parse(String(options.body))).toEqual({media_url:url});
});
it("adds controls to already-open supported tabs when installed",async()=>{
  const w=worker();await w.installed();
  expect(w.inject).toHaveBeenCalledWith({target:{tabId:42},files:["glass-button.js","youtube.js"]});
});
it("rediscovers after an app restart without replaying an accepted conversion",async()=>{
  const w=worker();const normal=w.fetch.getMockImplementation()!;let restarted=false;
  w.fetch.mockImplementation(async(endpoint:string,...args:unknown[])=>{
    if(restarted&&endpoint.endsWith("/api/extension-health")){restarted=false;return {ok:false,status:401,json:async()=>({})} as never;}
    return normal(endpoint,...args as []);
  });
  expect(await w.send({action:"ping"})).toMatchObject({alive:true});restarted=true;
  expect(await w.send({action:"ping"})).toMatchObject({alive:true});
  expect(w.fetch.mock.calls.filter(([endpoint])=>endpoint.endsWith("/api/extension-connect"))).toHaveLength(2);
  expect(w.fetch.mock.calls.some(([endpoint])=>endpoint.endsWith("/api/convert"))).toBe(false);
});
it("skips unrelated local services during automatic discovery",async()=>{
  const w=worker();const normal=w.fetch.getMockImplementation()!;
  w.fetch.mockImplementation(async(endpoint:string)=>endpoint.startsWith("http://127.0.0.1:27653/")?{ok:true,status:200,json:async()=>({application:"other-app",token:"not-a-lazymidi-credential"})} as never:normal(endpoint));
  expect(await w.send({action:"ping"})).toMatchObject({alive:true});
  expect(w.stored.serverUrl).toBe("http://127.0.0.1:27654");
  expect(w.fetch.mock.calls.some(([endpoint])=>endpoint==="http://127.0.0.1:27653/api/extension-health")).toBe(false);
});
it("adds Discord media actions and preserves signed attachment queries",async()=>{
  const w=worker();w.installed();expect(w.create).toHaveBeenCalledWith(expect.objectContaining({contexts:["link","audio","video"]}));
  const url="https://cdn.discordapp.com/attachments/123/456/piano.mp3?ex=deadbeef&is=123&hm=signature";
  await w.click({menuItemId:"lazymidi-discord",linkUrl:url});
  expect(JSON.parse(String((w.fetch.mock.calls.find(([endpoint])=>endpoint.endsWith("/api/convert")) as unknown as [string,RequestInit])[1].body))).toEqual({media_url:url});
  expect(w.stored.lastJobId).toBe("job-id");expect(w.badge).toHaveBeenCalledWith({text:"…"});
});
it.each(["https://cdn.discordapp.com.evil.test/attachments/123/456/a.mp3","https://cdn.discordapp.com/attachments/123/456/a.exe","http://127.0.0.1/a.mp3","https://discord.com/channels/123/456","https://user:pass@youtube.com/watch?v=a"])("rejects invalid media %s",async url=>{
  const w=worker();expect(await w.send({action:"startConvert",url})).toMatchObject({success:false});expect(w.fetch).not.toHaveBeenCalled();
});
it("reports missing-app errors and keeps discovery on loopback ports",async()=>{
  const w=worker(false);expect(await w.send({action:"startConvert",url:"https://youtu.be/abc"})).toMatchObject({success:false,error:expect.stringContaining("Open lazymidi")});
  expect(w.fetch.mock.calls.every(([endpoint])=>/^http:\/\/127\.0\.0\.1:276(5[3-9]|60)\//.test(endpoint))).toBe(true);
  await w.click({menuItemId:"lazymidi-discord",srcUrl:"https://media.discordapp.net/attachments/123/456/a.webm"});
  expect(w.stored.jobError).toContain("Open lazymidi");expect(w.badge).toHaveBeenCalledWith({text:"!"});
});
it("imports a downloaded MuseScore MIDI with scoped credentials and rejects invalid files",async()=>{
  const w=worker();
  expect(await w.send({action:"importMidi",data:btoa("MThdtest"),filename:"score.mid",sourceUrl:"https://musescore.com/user/1/scores/123"})).toMatchObject({success:true,midi_name:"score.mid"});
  const [endpoint,options]=w.fetch.mock.calls.find(([endpoint])=>endpoint.endsWith("/api/import-midi")) as unknown as [string,RequestInit];
  expect(endpoint).toBe("http://127.0.0.1:27653/api/import-midi");expect((options.body as FormData).get("source")).toBe("musescore");
  w.fetch.mockClear();expect(await w.send({action:"importMidi",data:btoa("invalid")})).toMatchObject({success:false});expect(w.fetch).not.toHaveBeenCalled();
});
it.each([false,true])("downloads MuseScore MIDI using LibreScore authorization (fallback=%s)",async fallback=>{
  const dom=new JSDOM('<head><meta property="og:title" content="Piano | MuseScore.com"><link href="https://musescore.com/static/public/build/musescore_es6/201.test.js"></head><body><button id="audioconverter-ms-btn">Old import</button><input id="audioconverter-ms-picker" type="file"></body>',{url:'https://musescore.com/user/120802646/scores/34743503'});
  const messages:Array<Record<string,any>>=[];
  let attempts=0;
  const fetch=vi.fn(async(url:string)=>url.includes('201.test.js')?{ok:true,text:async()=>'md5(id+"suffix-from-current-bundle").substr(0,4)'}:
    {ok:!fallback||++attempts>1,json:async()=>({info:{url:'https://s.musescore.com/score.mid?signature=keep'}})});
  const state=vi.fn((button:HTMLButtonElement,label:string)=>button.textContent=label);
  const context=createContext({document:dom.window.document,location:dom.window.location,URL,AbortController,fetch,
    chrome:{runtime:{sendMessage:(request:Record<string,any>,reply:(response:unknown)=>void)=>{messages.push(request);reply(request.action==='ping'?{success:true,alive:true}:{success:true,midi_name:'piano.mid'});}}},
    acCreateGlassButton:(id:string,label:string)=>{const button=dom.window.document.createElement('button');button.id=id;button.textContent=label;return button;},acSetGlassState:state,
    setInterval:vi.fn(),clearInterval:vi.fn(),setTimeout,clearTimeout,console});
  try{
    for(const script of ['vendor/md5.min.js','musescore.js'])runInContext(readFileSync(new URL(`../extension/${script}`,import.meta.url),'utf8'),context);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await vi.waitFor(()=>expect(dom.window.document.getElementById('audioconverter-ms-btn')).not.toBeNull());
    const button=dom.window.document.getElementById('audioconverter-ms-btn') as HTMLButtonElement;
    expect(dom.window.document.querySelector('input[type=file]')).toBeNull();
    button.click();button.click();
    await vi.waitFor(()=>expect(button.textContent).toBe('✓ Added to app'));
    expect(dom.window.document.querySelectorAll('button')).toHaveLength(1);
    const calls=fetch.mock.calls.filter(([url])=>url.startsWith('/api/jmuse')) as unknown as Array<[string,RequestInit]>;
    expect(calls[0][0]).toBe('/api/jmuse?id=34743503&type=midi&index=0');
    expect(calls[0][1].headers).toEqual({Authorization:createHash('md5').update('34743503midi0suffix-from-current-bundle').digest('hex').slice(0,4)});
    if(fallback)expect(calls[1][1].headers).toEqual({Authorization:createHash('md5').update('34743503midi09654,4e').digest('hex').slice(0,4)});
    expect(messages.filter(message=>message.action==='downloadMuseScore')).toEqual([{action:'downloadMuseScore',url:'https://s.musescore.com/score.mid?signature=keep',title:'Piano',sourceUrl:dom.window.location.href,thumbnailUrl:''}]);
  }finally{runInContext('globalThis.lazymidiScoreCleanup?.()',context);dom.window.close();}
});
it('downloads and imports a MuseScore MIDI without exposing local credentials to the CDN',async()=>{
  const w=worker();const normal=w.fetch.getMockImplementation()!;
  const url='https://s.musescore.com/score.mid?signature=keep';
  w.fetch.mockImplementation(async(endpoint:string)=>endpoint===url?new Response('MThdtest') as never:normal(endpoint));
  expect(await w.send({action:'downloadMuseScore',url,sourceUrl:'https://musescore.com/user/1/scores/123',title:'Piano'})).toMatchObject({success:true});
  const [,options]=w.fetch.mock.calls.find(([endpoint])=>endpoint===url) as unknown as [string,RequestInit];
  expect(options).toMatchObject({credentials:'omit',redirect:'error'});expect(options.headers).toBeUndefined();
  const [,imported]=w.fetch.mock.calls.find(([endpoint])=>endpoint.endsWith('/api/import-midi')) as unknown as [string,RequestInit];
  expect((imported.body as FormData).get('title')).toBe('Piano');
  expect(await ((imported.body as FormData).get('file') as File).text()).toBe('MThdtest');
});
it.each(['https://musescore.com.evil.test/score.mid','http://127.0.0.1/private.mid','https://s.musescore.com:123/score.mid','https://user:pass@s.musescore.com/score.mid','https://s3.ultimate-guitar.com/private.mid'])('rejects an unsafe MuseScore download %s before fetching',async url=>{
  const w=worker();expect(await w.send({action:'downloadMuseScore',url,sourceUrl:'https://musescore.com/user/1/scores/123'})).toMatchObject({success:false});expect(w.fetch).not.toHaveBeenCalled();
});
it.each(['html','length','stream'])('rejects invalid or oversized MuseScore download (%s)',async kind=>{
  const w=worker();const normal=w.fetch.getMockImplementation()!;const url='https://s.musescore.com/score.mid';
  w.fetch.mockImplementation(async(endpoint:string)=>endpoint!==url?normal(endpoint):new Response(kind==='html'?'<html>Not MIDI</html>':new Uint8Array(kind==='stream'?20*1024**2+1:4),{headers:kind==='length'?{'Content-Length':String(20*1024**2+1)}:{}}) as never);
  expect(await w.send({action:'downloadMuseScore',url,sourceUrl:'https://musescore.com/user/1/scores/123'})).toMatchObject({success:false});
  expect(w.fetch.mock.calls.some(([endpoint])=>endpoint.endsWith('/api/import-midi'))).toBe(false);
});
it.each([false,true])("shows browser conversion status or errors in the popup (error=%s)",async failed=>{
  const dom=new JSDOM(readFileSync(new URL("../extension/popup.html",import.meta.url),"utf8"));
  const sendMessage=vi.fn(async(request:{action:string})=>request.action==="ping"?{success:true,alive:true}:{success:true,data:{status:"completed",midi_name:"piano.mid"}});
  const badge=vi.fn();
  const chrome={storage:{session:{get:async()=>({serverUrl:"http://127.0.0.1:1234",token:"token",lastJobId:"job-id",jobError:failed?"Converter is unavailable":""})}},runtime:{sendMessage},action:{setBadgeText:badge}};
  try{
    runInNewContext(readFileSync(new URL("../extension/popup.js",import.meta.url),"utf8"),{chrome,document:dom.window.document,window:dom.window,setTimeout:vi.fn(),clearTimeout:vi.fn()});
    await vi.waitFor(()=>expect(dom.window.document.getElementById("job")?.textContent).toBe(failed?"Converter is unavailable":"piano.mid"));
    expect(dom.window.document.getElementById("pair")).toBeNull();
    expect(dom.window.document.getElementById("status")?.textContent).toBe("Connected to lazymidi.");
    expect(sendMessage).toHaveBeenCalledTimes(failed?1:2);expect(badge).toHaveBeenCalledWith({text:""});
  }finally{dom.window.close();}
});
