// Local discovery and service credentials stay in the extension worker.
let connecting;
function connect() {
  if(!connecting)connecting=(async()=>{
    const bases=Array.from({length:8},(_,i)=>`http://127.0.0.1:${27653+i}`);
    const stored=await chrome.storage.session.get(['serverUrl']);
    if(bases.includes(stored.serverUrl))bases.unshift(...bases.splice(bases.indexOf(stored.serverUrl),1));
    for(const base of bases){
      const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),500);
      try{
        const res=await fetch(base+'/api/extension-connect',{headers:{'X-Lazymidi-Extension':'1'},signal:abort.signal,redirect:'error',credentials:'omit'});
        const data=await res.json();
        if(res.ok&&data.application==='lazymidi-converter'&&data.protocol===1&&typeof data.token==='string'&&data.token.length>=24){
          await chrome.storage.session.set({serverUrl:base});return {base,token:data.token};
        }
      }catch{/* Try the next local converter port. */}finally{clearTimeout(timer);}
    }
    throw new Error('Open lazymidi with Converter enabled and a compatible Python environment selected.');
  })().catch(error=>{connecting=null;throw error;});
  return connecting;
}
async function serviceFetch(path, options={},retry=true) {
  const service=await connect();
  let response;
  try{response=await fetch(service.base+path,{...options,redirect:'error',credentials:'omit',headers:{...options.headers,'X-Lazymidi-Token':service.token}});}
  catch(error){connecting=null;throw error;}
  if(response.status===401&&retry){connecting=null;return serviceFetch(path,options,false);}
  return response;
}

function describeFetchError(err) {
  const message = String((err && err.message) || err);
  return message.includes('Failed to fetch')
    ? 'lazymidi converter is unavailable; keep the app running with Converter enabled'
    : message;
}

async function startConvert(value) {
  const url = new URL(value);
  const discord = /^(cdn|media)\.discordapp\.(com|net)$/.test(url.hostname);
  const video = ['youtube.com','www.youtube.com','youtu.be','tiktok.com','www.tiktok.com','vm.tiktok.com','vt.tiktok.com'].includes(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(video || (discord && /^\/attachments\/\d+\/\d+\/[^/]+\.(mp3|wav|flac|ogg|opus|m4a|aac|mp4|webm|mov|mkv)$/i.test(url.pathname)))) {
    throw new Error('Choose a YouTube/TikTok video or a Discord audio/video attachment.');
  }
  // Preserve signed Discord queries; the service chooses the saved compute device.
  const res = await serviceFetch('/api/convert', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({media_url:url.href}),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.task_id) throw new Error(payload.error || `Server returned HTTP ${res.status}`);
  await chrome.storage.session.set({lastJobId:payload.task_id,jobError:''});
  await chrome.action.setBadgeText({text:'…'});
  return payload;
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({
    id:'lazymidi-discord', title:'Convert with lazymidi', contexts:['link','audio','video'],
    targetUrlPatterns:['https://cdn.discordapp.com/attachments/*','https://media.discordapp.net/attachments/*','https://cdn.discordapp.net/attachments/*','https://media.discordapp.com/attachments/*'],
  }));
  for(const script of chrome.runtime.getManifest().content_scripts){
    try{
      const tabs=await chrome.tabs.query({url:script.matches});
      await Promise.allSettled(tabs.filter(tab=>tab.id!==undefined).map(tab=>chrome.scripting.executeScript({target:{tabId:tab.id},files:script.js})));
    }catch{/* Closed tabs and browser-denied pages can be skipped. */}
  }
});
chrome.contextMenus.onClicked.addListener(async info => {
  if (info.menuItemId !== 'lazymidi-discord') return;
  try { await startConvert(info.srcUrl || info.linkUrl); }
  catch (error) {
    await chrome.storage.session.set({lastJobId:'',jobError:describeFetchError(error)});
    await chrome.action.setBadgeText({text:'!'});
  }
});

// Listen for messages from the content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  

  if (request.action === 'ping') {
    // Content scripts only show their button while the app is reachable
    (async () => {
      try {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 3000);
        const res = await serviceFetch('/api/extension-health', { signal: abort.signal });
        clearTimeout(timer);
        const payload = await res.json().catch(() => ({}));
        sendResponse({ success: true, alive: res.ok && payload.status === 'ok' });
      } catch (err) {
        sendResponse({ success: true, alive: false });
      }
    })();

    return true; // async response
  }

  if (request.action === 'startConvert') {
    (async () => {
      try {
        const payload = await startConvert(request.url);
        sendResponse({ success: true, task_id: payload.task_id });
      } catch (err) {
        sendResponse({ success: false, error: describeFetchError(err) });
      }
    })();

    return true; // async response
  }

  if (request.action === 'convertStatus') {
    (async () => {
      try {
        const res = await serviceFetch(`/api/status/${encodeURIComponent(request.taskId)}`);
        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          sendResponse({ success: false, error: payload.error || `Server returned HTTP ${res.status}` });
          return;
        }
        sendResponse({ success: true, data: payload });
      } catch (err) {
        sendResponse({ success: false, error: describeFetchError(err) });
      }
    })();

    return true; // async response
  }

  if (request.action === 'importMidi' || request.action === 'downloadMuseScore') {
    // Push a MIDI fetched by the MuseScore content script into the local app.
    // Sent from here, not the content script: the service worker's
    // host_permissions let it post to 127.0.0.1 without CORS headers.
    (async () => {
      try {
        let bytes;
        let filename = request.filename || 'score.mid';
        if (request.action === 'downloadMuseScore') {
          const source = new URL(request.sourceUrl);
          const score = /\/scores?\/(\d+)\/?$/.exec(source.pathname)?.[1];
          const url = new URL(request.url);
          const allowed = url.hostname === 'musescore.com' || url.hostname.endsWith('.musescore.com') ||
            url.hostname === 'musescore-public.s3.amazonaws.com' ||
            (url.hostname === 's3.ultimate-guitar.com' && url.pathname.startsWith('/musescore/'));
          if (source.protocol !== 'https:' || !['musescore.com','www.musescore.com','s.musescore.com'].includes(source.hostname) ||
              source.username || source.password || source.port || !score ||
              !allowed || url.protocol !== 'https:' || url.username || url.password || url.port) {
            throw new Error('MuseScore returned an unsupported MIDI download URL.');
          }
          await connect();
          const abort = new AbortController();
          const timer = setTimeout(() => abort.abort(), 30000);
          try {
            const download = await fetch(url.href, {signal:abort.signal, credentials:'omit', redirect:'error'});
            if (!download.ok) throw new Error(`MIDI download returned HTTP ${download.status}`);
            const limit = 20 * 1024**2;
            if (Number(download.headers.get('Content-Length')) > limit) throw new Error('MIDI file is too large.');
            const reader = download.body.getReader();
            const chunks = []; let length = 0;
            try {
              while (true) {
                const {done, value} = await reader.read();
                if (done) break;
                length += value.length;
                if (length > limit) throw new Error('MIDI file is too large.');
                chunks.push(value);
              }
            } finally { await reader.cancel(); }
            bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          } finally { clearTimeout(timer); }
          filename = `musescore-${score}.mid`;
        } else {
          const binary = atob(request.data || '');
          if (binary.length > 20 * 1024**2) throw new Error('Choose a valid MIDI file under 20 MB.');
          bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        }
        if (bytes.length < 4 || bytes[0] !== 0x4d || bytes[1] !== 0x54 || bytes[2] !== 0x68 || bytes[3] !== 0x64) {
          throw new Error('MuseScore did not return a valid MIDI file.');
        }

        const form = new FormData();
        form.append('file', new Blob([bytes], { type: 'audio/midi' }), filename);
        form.append('title', request.title || '');
        form.append('source_url', request.sourceUrl || '');
        form.append('thumbnail_url', request.thumbnailUrl || '');
        form.append('source', 'musescore');

        const res = await serviceFetch('/api/import-midi', { method: 'POST', body: form });
        const payload = await res.json().catch(() => ({}));

        if (!res.ok || !payload.success) {
          sendResponse({ success: false, error: payload.error || `Server returned HTTP ${res.status}` });
          return;
        }
        sendResponse({ success: true, midi_name: payload.midi_name });
      } catch (err) {
        sendResponse({ success: false, error: describeFetchError(err) });
      }
    })();

    return true; // async response
  }

  return false;
});

