// Paired loopback access stays in the extension worker.

async function serverBase() {
  const stored=await chrome.storage.session.get(['serverUrl','token']);
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(stored.serverUrl||'') || !stored.token) throw new Error('Pair the extension using lazymidi → Convert.');
  return stored.serverUrl;
}
async function serviceFetch(url, options={}) {
  const stored=await chrome.storage.session.get(['token']);
  return fetch(url,{...options,headers:{...options.headers,'X-Lazymidi-Token':stored.token||''}});
}

function describeFetchError(err) {
  const message = String((err && err.message) || err);
  return message.includes('Failed to fetch')
    ? 'lazymidi converter is unavailable; pair again if it restarted'
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
  const base = await serverBase();
  // Preserve signed Discord queries; the service chooses the saved compute device.
  const res = await serviceFetch(base + '/api/convert', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({media_url:url.href}),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.task_id) throw new Error(payload.error || `Server returned HTTP ${res.status}`);
  await chrome.storage.session.set({lastJobId:payload.task_id,jobError:''});
  await chrome.action.setBadgeText({text:'…'});
  return payload;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({
    id:'lazymidi-discord', title:'Convert with lazymidi', contexts:['link','audio','video'],
    targetUrlPatterns:['https://cdn.discordapp.com/attachments/*','https://media.discordapp.net/attachments/*','https://cdn.discordapp.net/attachments/*','https://media.discordapp.com/attachments/*'],
  }));
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
        const base = await serverBase();
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 3000);
        const res = await serviceFetch(base + '/api/extension-health', { signal: abort.signal });
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
        const base = await serverBase();
        const res = await serviceFetch(`${base}/api/status/${encodeURIComponent(request.taskId)}`);
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

  if (request.action === 'importMidi') {
    // Push a MIDI fetched by the MuseScore content script into the local app.
    // Sent from here, not the content script: the service worker's
    // host_permissions let it post to 127.0.0.1 without CORS headers.
    (async () => {
      try {
        const base = await serverBase();

        const binary = atob(request.data || '');
        if (binary.length > 20 * 1024**2 || binary.slice(0,4) !== 'MThd') throw new Error('Choose a valid MIDI file under 20 MB.');
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const form = new FormData();
        form.append('file', new Blob([bytes], { type: 'audio/midi' }), request.filename || 'score.mid');
        form.append('title', request.title || '');
        form.append('source_url', request.sourceUrl || '');
        form.append('thumbnail_url', request.thumbnailUrl || '');
        form.append('source', 'musescore');

        const res = await serviceFetch(base + '/api/import-midi', { method: 'POST', body: form });
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

