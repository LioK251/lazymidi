// Adapted from LibreScore/dl-librescore (MIT), revision 5a9491f977f900943cb6f1ed3d703eb701bb03a6.
// Full notice: vendor/dl-librescore-LICENSE.txt.
(function () {
  'use strict';

  const BTN_ID = 'audioconverter-ms-btn';
  const IDLE_LABEL = 'Download MIDI to lazymidi';
  const timers=[];let stopped=false;
  let activeDownload;
  globalThis.lazymidiScoreCleanup?.();
  removeButton();
  globalThis.lazymidiScoreCleanup=()=>{stopped=true;activeDownload?.abort();timers.forEach(clearInterval);removeButton();};
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

  async function midiUrl(signal, sourceUrl) {
    const id = /\/scores?\/(\d+)(?:\/|$)/.exec(new URL(sourceUrl).pathname)?.[1];
    if (!id) throw new Error('Open a MuseScore score first');
    let suffix = null;
    const scripts = [...document.querySelectorAll('script[src],link[href]')]
      .map(node => new URL(node.src || node.href, sourceUrl))
      .filter(url => url.origin === location.origin && /\/static\/public\/build\/musescore.*\/20.*\.js$/.test(url.pathname));
    for (const url of [...new Set(scripts.map(url => url.href))].slice(0, 8)) {
      try {
        const response = await fetch(url, {signal, credentials:'same-origin', redirect:'error'});
        if (!response.ok) continue;
        const text = await response.text();
        suffix = /["']([^"']+)["']\)\.substr\(0,\s*4\)/.exec(text)?.[1] ?? null;
        if (suffix !== null) break;
      } catch (error) { if (signal.aborted) throw error; }
    }
    for (const value of [...new Set([suffix, '9654,4e'])]) {
      const auth = md5(`${id}midi0${value}`).slice(0, 4);
      const response = await fetch(`/api/jmuse?id=${id}&type=midi&index=0`, {
        headers:{Authorization:auth}, signal, credentials:'same-origin', redirect:'error',
      });
      if (!response.ok) continue;
      const payload = await response.json();
      if (typeof payload?.info?.url === 'string') return payload.info.url;
    }
    // shortcut: native-player token capture is not included; revisit if MuseScore stops accepting both upstream token variants.
    throw new Error('MuseScore did not provide a MIDI download for this score.');
  }

  async function downloadMidi(button) {
    busy = true;
    button.disabled = true;
    acSetGlassState(button, 'Downloading MIDI…', 'busy');
    const controller = new AbortController();
    activeDownload = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    const sourceUrl = location.href.split(/[?#]/)[0];
    const title = meta('og:title').replace(/\s*\|\s*MuseScore\.com\s*$/i, '').trim();
    const thumbnailUrl = meta('og:image');
    try {
      const health = await sendToWorker({action:'ping'}, 6000);
      if (!health?.alive) throw new Error('Open lazymidi with Converter enabled.');
      const url = await midiUrl(controller.signal, sourceUrl);
      if (controller.signal.aborted) throw new Error('MIDI download cancelled.');
      const response = await sendToWorker({
        action: 'downloadMuseScore', url, title, sourceUrl, thumbnailUrl,
      });
      if (!response?.success) throw new Error(response?.error || 'Import failed');
      acSetGlassState(button, '✓ Added to app', 'done');
      button.title = `Imported ${response.midi_name || 'score.mid'}`;
    } catch (error) {
      console.error('lazymidi MuseScore import:', error);
      acSetGlassState(button, `✕ ${error.message}`, 'error');
      button.title = error.message;
    } finally {
      clearTimeout(timeout);
      busy = false;
      button.disabled = false;
      setTimeout(() => { if (!busy) acSetGlassState(button, IDLE_LABEL, ''); }, 5000);
    }
  }

  function removeButton() {
    document.getElementById(BTN_ID)?.remove();
    document.getElementById('audioconverter-ms-picker')?.remove();
  }

  function injectButton() {
    if (document.getElementById(BTN_ID) || !isScorePage()) return;
    const button = acCreateGlassButton(BTN_ID, IDLE_LABEL);
    button.title = 'Download this score’s MIDI directly into lazymidi';
    button.addEventListener('click', () => { if (!busy) downloadMidi(button); });
    document.body.append(button);
  }

  async function syncButton() {
    if (stopped || syncing) return;
    syncing = true;
    try {
      if (!isScorePage()) { removeButton(); return; }
      const page=location.href;
      const response = await sendToWorker({ action: 'ping' }, 6000).catch(() => null);
      if(stopped||location.href!==page)return;
      const alive = !!(response?.success && response.alive);
      if(alive&&!busy)injectButton();
      const button=document.getElementById(BTN_ID);
      if(button){button.dataset.lazymidiOnline=String(alive);button.hidden=!alive;if(!alive&&!busy)removeButton();}
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
