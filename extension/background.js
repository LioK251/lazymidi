// Background service worker for AudioConverter extension

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
    // Kick off a YouTube/TikTok conversion in the local app
    (async () => {
      try {
        const base = await serverBase();
        const res = await serviceFetch(base + '/api/convert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: request.url, media_url: request.url, device: 'cpu' }),
        });
        const payload = await res.json().catch(() => ({}));

        if (!res.ok || !payload.task_id) {
          sendResponse({ success: false, error: payload.error || `Server returned HTTP ${res.status}` });
          return;
        }
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

