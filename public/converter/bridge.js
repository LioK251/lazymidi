/* Local visualizer bridge: service credentials stay in Rust. */
let settings = {};
let nextRequest = 0;
const pending = new Map();
let assetRoot = '';
let visualizeRevision = 0;
let playbackRevision = 0;
const soundFontChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('lazymidi-soundfont') : null;
const scoreMode = new URLSearchParams(location.search).get('score') === '1';
if (scoreMode) {
  document.documentElement.classList.add('score-transport');
  window.onPianoPlayback = state => parent.postMessage({type:'converter-playback',revision:playbackRevision,...state},location.origin);
  new ResizeObserver(() => parent.postMessage({type:'converter-player-size',height:document.body.scrollHeight},location.origin)).observe(document.body);
}
const nativeFetch = window.fetch.bind(window);
function backgroundPath(value) {
  return typeof value === 'string' ? value.match(/^(?:(?:https?:\/\/converter\.localhost|converter:\/\/localhost))?(\/visualizer-backgrounds\/[0-9a-f]{32}\.(?:jpg|jpeg|png|webp|gif|mp4|webm|mov))$/)?.[1] ?? null : null;
}
function soundFontPath(value) {
  if(value==='builtin')return value;
  if(typeof value!=='string'||!value)return null;
  try {
    const url=new URL(value,location.origin);
    if(url.username||url.password||url.search||url.hash)return null;
    if(![location.origin,'http://converter.localhost','https://converter.localhost'].includes(url.origin)&&!(url.protocol==='converter:'&&url.hostname==='localhost'))return null;
    const match=/^\/soundfonts\/([^/\\]+\.sf2)$/i.exec(decodeURIComponent(url.pathname).replace(/^\/+/, '/'));
    return match?'/soundfonts/'+encodeURIComponent(match[1]):null;
  }catch{return null;}
}
function canonicalSettings(value) {
  const {visualizer_hands: _removed, ...current} = value;
  return {...current,...('visualizer_soundfont' in current?{visualizer_soundfont:soundFontPath(current.visualizer_soundfont)||'builtin'}:{}),visualizer_scenes:Object.fromEntries(Object.entries(current.visualizer_scenes||{}).map(([style,scene])=>[style,{...scene,...(backgroundPath(scene.media_url)?{media_url:backgroundPath(scene.media_url)}:{})}]))};
}
window.resolvePianoSoundFont = value => {
  const path=soundFontPath(value);
  return path==='builtin'?path:path&&assetRoot?assetRoot+path.slice(1):null;
};
if(soundFontChannel)soundFontChannel.onmessage=event=>{
  const path=soundFontPath(event.data);
  if(!path||path===settings.visualizer_soundfont)return;
  settings={...settings,visualizer_soundfont:path};
  parent.postMessage({type:'converter-settings-save',settings:{visualizer_soundfont:path}},location.origin);
  if(assetRoot)void window.refreshPianoSoundFonts?.(window.resolvePianoSoundFont(path));
};
window.addEventListener('pagehide',event=>{if(!event.persisted)soundFontChannel?.close();});
window.resolveVisualizerBackground = value => {
  const path = backgroundPath(value);
  return path && assetRoot ? assetRoot + path.slice(1) : null;
};
window.fetch = async function(input, options = {}) {
  const path = typeof input === 'string' ? input : input.url;
  if (path.startsWith('/api/midi/')) return nativeFetch(assetRoot + 'converted/' + path.slice('/api/midi/'.length));
  if (path.startsWith('/soundfonts/') || path.startsWith('/visualizer-backgrounds/')) return nativeFetch(assetRoot + path.slice(1),options);
  if (!path.startsWith('/api/')) return nativeFetch(input, options);
  const id = ++nextRequest;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {pending.delete(id);reject(new Error('Converter did not respond.'));},30000);
    pending.set(id, {resolve, reject, timeout});
    parent.postMessage({type:'converter-fetch',id,path,body:options.body ? JSON.parse(options.body) : undefined},location.origin);
  });
};
window.loadSheetsSettingsSync = () => settings;
window.loadSheetsSettings = async () => settings;
window.saveSheetsSettings = async value => {
  value=canonicalSettings(value);
  const changed=Object.fromEntries(Object.entries(value).filter(([key,v])=>JSON.stringify(settings[key])!==JSON.stringify(v)));
  settings=value;
  if(!Object.keys(changed).length)return;
  parent.postMessage({type:'converter-settings-save',settings:changed},location.origin);
  if('visualizer_soundfont' in changed)soundFontChannel?.postMessage(changed.visualizer_soundfont);
};
window.showAlert = message => alert(message);
window.addEventListener('message',event=>{
  if(event.source!==parent || event.origin!==location.origin) return;
  const message=event.data;
  if(message?.type==='converter-fetch-result') {
    const request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timeout);
    if(message.error)request.reject(new Error(message.error));
    else {
      let value=message.value;
      if(value?.soundfonts) value={...value,soundfonts:value.soundfonts.map(font=>({...font,url:assetRoot+String(font.url).replace(/^\//,'')}))};
      request.resolve(new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}}));
    }
  }
  if(message?.type==='converter-visibility') window.setVisualizerActive?.(message.visible);
  if(message?.type==='converter-style') {
    settings={...settings,visualizer_style:message.style};
    window.dispatchEvent(new CustomEvent('piano-style-change',{detail:message.style}));
  }
  if(message?.type==='converter-appearance') {
    const changed=Object.fromEntries(Object.entries(message.settings||{}).filter(([key])=>key.startsWith('visualizer_')||key.startsWith('hand_')||key==='download_hands'));
    const previousFont=settings.visualizer_soundfont;
    settings=canonicalSettings({...settings,...changed});
    if(assetRoot&&settings.visualizer_soundfont!==previousFont)void window.refreshPianoSoundFonts?.(window.resolvePianoSoundFont(settings.visualizer_soundfont));
    window.dispatchEvent(new CustomEvent('piano-style-change',{detail:settings.visualizer_style}));
  }
  if(message?.type==='converter-import-complete')window.dispatchEvent(new CustomEvent('piano-import-complete'));
  if(message?.type==='converter-soundfonts')void window.refreshPianoSoundFonts?.(assetRoot+'soundfonts/'+encodeURIComponent(message.filename));
  if(message?.type==='converter-visualize') {
    const revision=++visualizeRevision;
    playbackRevision=message.revision;
    settings=canonicalSettings(message.settings);
    assetRoot=message.assetRoot;
    if(message.filename)void window.openPianoVisualizer(message.filename,message.midiBase64).then(()=>{if(revision===visualizeRevision)parent.postMessage({type:'converter-visualizer-ready',filename:message.filename,loaded:document.getElementById('pv-export-hands')?.disabled===false},location.origin);});
  }
});
