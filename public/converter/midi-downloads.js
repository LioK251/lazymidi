(function () {
  'use strict';
  let libraryPromise;
  function ensureLibrary() {
    if (window.Midi) return Promise.resolve();
    if (!libraryPromise) libraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/converter/Midi.js';
      script.onload = resolve;
      script.onerror = () => { script.remove(); libraryPromise = null; reject(new Error('Could not load the MIDI library. Please retry.')); };
      document.head.appendChild(script);
    });
    return libraryPromise;
  }
  function save(buffer, midi, hands, filename, split = true) {
    const helpers = window.PianoEnhancements;
    const data = split ? helpers.encodeMidi(helpers.splitHands(midi, hands)) : buffer;
    const url = URL.createObjectURL(new Blob([data], { type: 'audio/midi' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename.replace(/\.(mid|midi)$/i, '') + (split ? '_hands' : '') + '.mid';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  document.addEventListener('click', async event => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/converted/') || !/\.(mid|midi)$/i.test(url.pathname)) return;
    event.preventDefault();
    if (link.dataset.downloading === 'true') return;
    link.dataset.downloading = 'true'; link.setAttribute('aria-busy', 'true');
    try {
      const settings = await loadSheetsSettings();
      const filename = decodeURIComponent(url.pathname.slice('/converted/'.length));
      // Fetch the untouched source; manual corrections use the same content key
      // as the visualizer, even if the file has since been renamed.
      const response = await fetch('/api/midi/' + encodeURIComponent(filename));
      if (!response.ok) throw new Error('Could not download MIDI: ' + response.status);
      const buffer = await response.arrayBuffer();
      if (settings.download_hands === false) { save(buffer, null, null, filename, false); return; }
      await ensureLibrary();
      const midi = new Midi(buffer);
      const helpers = window.PianoEnhancements;
      const estimates = helpers.estimateHands(helpers.describeNotes(midi));
      const corrections = helpers.readOverrides(await helpers.storageKey(buffer), estimates);
      save(buffer, midi, { ...estimates, ...corrections }, filename);
    } catch (error) {
      if (typeof showAlert === 'function') showAlert(error.message, 'MIDI download failed');
      else window.alert(error.message);
    } finally {
      delete link.dataset.downloading; link.removeAttribute('aria-busy');
    }
  });
  window.MidiDownloads = { ensureLibrary, save };
})();
