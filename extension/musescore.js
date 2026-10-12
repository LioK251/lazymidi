// Import a MIDI obtained through the score page's own download controls.
// MuseScore's old jmuse token endpoint is no longer a dependable export path.
(function () {
  'use strict';

  const BTN_ID = 'audioconverter-ms-btn';
  const PICKER_ID = 'audioconverter-ms-picker';
  const IDLE_LABEL = 'Import downloaded MIDI';
  const timers=[];let stopped=false;
  globalThis.lazymidiScoreCleanup?.();
  globalThis.lazymidiScoreCleanup=()=>{stopped=true;timers.forEach(clearInterval);removeButton();};
  let busy = false;
  let syncing = false;

  function isScorePage() {
    return /\/scores?\/\d+(?:\/|$)/.test(location.pathname);
  }

  function meta(property) {
    return document.querySelector(`meta[property="${property}"]`)?.content || '';
  }

  function sendToWorker(message, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('Extension worker did not respond')); }
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage(message, response => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(response);
        });
      } catch (error) {
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
      }
    });
  }

  function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  async function importFile(file, button) {
    busy = true;
    button.disabled = true;
    acSetGlassState(button, 'Importing MIDI…', 'busy');
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('MIDI file is too large');
      const buffer = await file.arrayBuffer();
      const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
      if (head.length !== 4 || head[0] !== 0x4d || head[1] !== 0x54 ||
          head[2] !== 0x68 || head[3] !== 0x64) {
        throw new Error('Choose a MIDI (.mid or .midi) file');
      }
      const response = await sendToWorker({
        action: 'importMidi',
        data: bytesToBase64(buffer),
        filename: file.name,
        title: meta('og:title').replace(/\s*\|\s*MuseScore\.com\s*$/i, '').trim(),
        sourceUrl: location.href.split('?')[0],
        thumbnailUrl: meta('og:image'),
      });
      if (!response?.success) throw new Error(response?.error || 'Import failed');
      acSetGlassState(button, '✓ Added to app', 'done');
      button.title = `Imported ${response.midi_name || file.name}`;
    } catch (error) {
      console.error('lazymidi MuseScore import:', error);
      acSetGlassState(button, `✕ ${error.message}`, 'error');
      button.title = error.message;
    } finally {
      busy = false;
      button.disabled = false;
      setTimeout(() => { if (!busy) acSetGlassState(button, IDLE_LABEL, ''); }, 5000);
    }
  }

  function removeButton() {
    document.getElementById(BTN_ID)?.remove();
    document.getElementById(PICKER_ID)?.remove();
  }

  function injectButton() {
    if (document.getElementById(BTN_ID) || !isScorePage()) return;
    const button = acCreateGlassButton(BTN_ID, IDLE_LABEL);
    button.title = 'Download MIDI from MuseScore, then choose the file to import into lazymidi';
    const picker = document.createElement('input');
    picker.id = PICKER_ID;
    picker.type = 'file';
    picker.accept = '.mid,.midi,audio/midi';
    picker.style.display = 'none';
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (file) importFile(file, button);
    });
    button.addEventListener('click', () => { if (!busy) picker.click(); });
    document.body.append(button, picker);
  }

  async function syncButton() {
    if (stopped || syncing || busy) return;
    syncing = true;
    try {
      if (!isScorePage()) { removeButton(); return; }
      injectButton();
      const response = await sendToWorker({ action: 'ping' }, 6000).catch(() => null);
      const alive = !!(response?.success && response.alive);
      const button=document.getElementById(BTN_ID);
      if(button&&!busy)button.title=alive?'Download MIDI from MuseScore, then choose the file to import into lazymidi':'Open lazymidi with Converter enabled.';
    } finally { syncing = false; }
  }

  function boot() {
    if(stopped)return;
    syncButton();
    let lastPath = location.pathname;
    timers.push(setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        if (!busy) removeButton();
      }
      syncButton();
    }, 3000));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
