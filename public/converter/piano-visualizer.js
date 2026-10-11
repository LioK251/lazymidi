/**
 * Piano Visualizer — MIDI playback with SoundFont synthesis and Canvas visualization.
 *
 * Dependencies (CDN):
 *   - @tonejs/midi  — MIDI file parsing
 *   - js-synthesizer — FluidSynth WASM for SF2 playback
 *
 * Public API:
 *   window.openPianoVisualizer(midiFilename)
 */
(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────
  let midi = null;
  let visualizerActive = true;
  let synth = null;
  let audioCtx = null;
  let gainNode = null;
  let isPlaying = false;
  let isPaused = false;
  let playbackStarting = false;
  let pauseOffset = 0;
  let isScrubbing = false;
  let seekWasPlaying = false;
  let totalDuration = 0;
  let animFrameId = null;
  let currentSfUrl = '';
  let currentSfId = -1;
  let synthReady = false;
  let currentFilename = '';
  let openRevision = 0;
  let soundFontLoad = null;
  let soundFontLoadingUrl = '';
  let midiArrayBuffer = null;
  let handEstimates = {};
  let handOverrides = {};
  let handStorageKey = '';
  let selectedNoteId = null;
  let noteHitboxes = [];
  let editingHands = false;
  const handEnabled = { left: true, right: true };
  let playbackToken = 0;
  let playerHooked = false;
  let recording = null;
  const BUILTIN_PIANO = 'builtin';
  let liteTimer = null;
  const liteVoices = new Set();

  // AudioContext-based master clock
  let audioStartCtxTime = 0;  // audioCtx.currentTime when play started
  let audioStartMidiTime = 0; // MIDI-file seconds at that moment (= fromTime)
  let startTimeFallback = 0;  // performance.now()/1000 fallback

  // Extracted MIDI data
  let maxNoteDuration = 0;    // longest single note, for windowed render lookup
  let allNotes = [];          // [{start, end, releaseEnd, midi, velocity, channel, track}] sorted by start
  let allCCEvents = [];       // [{time, ch, cc, value}]                         sorted by time
  let pitchBendEvents = [];   // [{time, ch, value}]                             sorted by time
  const PIANO_MIN_NOTE = 21;  // A0
  const PIANO_MAX_NOTE = 108; // C8
  let minNote = PIANO_MIN_NOTE;
  let maxNote = PIANO_MAX_NOTE;

  // Piano key layout
  let pianoKeyLayout = [];
  let whiteKeyCount  = 0;
  let layoutBlackRatio = 0.58;
  let canvasCssWidth = 0;
  let canvasCssHeight = 0;
  let resizeRafId = null;

  // ─── DOM refs ────────────────────────────────────────────────────────
  const modal         = document.getElementById('piano-visualizer-modal');
  const content       = document.getElementById('piano-visualizer-content');
  const canvas        = document.getElementById('pv-canvas');
  const ctx           = canvas ? canvas.getContext('2d') : null;
  const titleEl       = document.getElementById('pv-title');
  const loadingEl     = document.getElementById('pv-loading');
  const loadingText   = document.getElementById('pv-loading-text');
  const loadingBar    = document.getElementById('pv-loading-bar');
  const btnPlay       = document.getElementById('pv-play');
  const btnStop       = document.getElementById('pv-stop');
  const btnClose      = document.getElementById('pv-close');
  const timeDisplay   = document.getElementById('pv-time-display');
  const volumeSlider  = document.getElementById('pv-volume');
  const volumeIcon    = document.getElementById('pv-volume-icon');
  const seekBar       = document.getElementById('pv-seek');
  const sfSelect      = document.getElementById('pv-soundfont-select');
  const styleSelect   = document.getElementById('pv-style-select');
  const keyboardSelect = document.getElementById('pv-keyboard-select');

  if (!modal || !canvas) return;

  const enhancements = window.PianoEnhancements;
  const tool = id => document.getElementById('pv-' + id);
  const toolStatus = message => { tool('tools-status').textContent = message; };
  function handFor(note) { return handOverrides[note.id] || handEstimates[note.id]; }
  function currentHands() { return Object.assign({}, handEstimates, handOverrides); }
  function persistHands() {
    try { localStorage.setItem(handStorageKey, JSON.stringify(handOverrides)); }
    catch (_) { toolStatus('Correction applied, but browser storage is full or unavailable. Download hand MIDI to keep it.'); }
  }
  function selectNote(id) {
    selectedNoteId = id;
    const note = allNotes.find(n => n.id === id);
    if (!note) return;
    const selector = tool('note-select');
    if (![...selector.options].some(o => o.value === id)) {
      selector.add(new Option(`${note.start.toFixed(2)}s · MIDI ${note.midi}`, id));
    }
    selector.value = id;
    toolStatus(`MIDI ${note.midi} at ${note.start.toFixed(2)}s: ${handFor(note) || 'unassigned'} hand${handOverrides[id] ? ' (corrected)' : ' (estimated)'}.`);
    renderFrame();
  }
  function refreshNoteChoices() {
    const selector = tool('note-select');
    selector.replaceChildren();
    const time = currentPlayTime();
    const nearby = allNotes.filter(n => n.piano && n.end >= time - 0.1).slice(0, 150);
    nearby.forEach(note => selector.add(new Option(`${note.start.toFixed(2)}s · MIDI ${note.midi} · ${handFor(note)}`, note.id)));
    if (nearby.length) selectNote(nearby.some(n => n.id === selectedNoteId) ? selectedNoteId : nearby[0].id);
    else selectedNoteId = null;
  }
  function setToolsBusy(busy) {
    document.querySelectorAll('.pv-hand-controls button, #pv-hand-editor button').forEach(button => { button.disabled = busy; });
  }
  function updateHandToggles() {
    const settings = loadSheetsSettingsSync();
    ['left', 'right'].forEach(hand => {
      const button = tool('toggle-' + hand);
      button.setAttribute('aria-pressed', String(handEnabled[hand]));
      button.title = `${handEnabled[hand] ? 'Mute and hide' : 'Enable'} ${hand} hand`;
      button.style.setProperty('--hand-color', settings['hand_' + hand + '_color'] || (hand === 'left' ? '#38bdf8' : '#f472b6'));
    });
  }
  ['left', 'right'].forEach(hand => tool('toggle-' + hand).addEventListener('click', () => {
    handEnabled[hand] = !handEnabled[hand];
    // Dedicated synth channels isolate pedal-held voices without touching the
    // other hand, the running SMF player, or its clock.
    if (!handEnabled[hand] && synth) {
      for (let ch = 0; ch < 16; ch++) synth.midiAllSoundsOff(ch + (hand === 'left' ? 16 : 32));
    }
    if (!handEnabled[hand]) {
      for (const voice of liteVoices) {
        if (voice.hand === hand) {
          try { voice.oscillator.stop(); } catch (_) {}
          liteVoices.delete(voice);
        }
      }
    }
    particles.length = 0;
    updateHandToggles(); renderFrame();
  }));
  tool('edit-hands').addEventListener('click', () => {
    editingHands = !editingHands;
    if (editingHands && isPlaying && !isPaused) pausePlayback();
    tool('edit-hands').setAttribute('aria-pressed', String(editingHands));
    tool('hand-editor').hidden = !editingHands;
    if (editingHands) refreshNoteChoices();
    resizeCanvas();
  });
  tool('note-select').addEventListener('change', event => selectNote(event.target.value));
  ['left', 'right', 'auto'].forEach(hand => tool('assign-' + hand).addEventListener('click', () => {
    if (!selectedNoteId) return;
    if (hand === 'auto') delete handOverrides[selectedNoteId];
    else handOverrides[selectedNoteId] = hand;
    persistHands(); selectNote(selectedNoteId);
  }));
  tool('reset-hands').addEventListener('click', () => {
    handOverrides = {}; persistHands(); refreshNoteChoices();
    toolStatus('Manual corrections reset to the estimated or named hands.');
  });
  canvas.addEventListener('click', event => {
    if (!editingHands) return;
    if (isPlaying && !isPaused) pausePlayback();
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * canvasCssWidth / rect.width;
    const y = (event.clientY - rect.top) * canvasCssHeight / rect.height;
    const hit = noteHitboxes.slice().reverse().find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    if (hit) selectNote(hit.id);
  });
  seekBar?.addEventListener('change', () => { if (editingHands) refreshNoteChoices(); });
  tool('export-hands').addEventListener('click', async () => {
    if (!midi) return;
    try {
      const settings = await loadSheetsSettings();
      window.MidiDownloads.save(midiArrayBuffer, midi, currentHands(), currentFilename, settings.download_hands !== false);
    } catch (error) { toolStatus(error.message); }
  });

  const artwork = window.PianoStyles;
  let visualStyle = artwork.normalize(loadSheetsSettingsSync().visualizer_style);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  if (styleSelect) {
    Object.entries(artwork.styles).forEach(([id, theme]) => {
      const option = document.createElement('option');
      option.value = id; option.textContent = theme.name;
      styleSelect.appendChild(option);
    });
    styleSelect.value = visualStyle;
    styleSelect.addEventListener('change', async () => {
      const value = artwork.normalize(styleSelect.value);
      setVisualStyle(value);
      styleSelect.disabled = true;
      try {
        const settings = await loadSheetsSettings();
        await saveSheetsSettings({ ...settings, visualizer_style: value });
      } finally {
        styleSelect.disabled = false;
      }
    });
  }

  if (keyboardSelect) {
    Object.entries(artwork.keyboardStyles).forEach(([id, name]) => keyboardSelect.add(new Option(name, id)));
    keyboardSelect.addEventListener('change', async () => {
      const style = visualStyle;
      const value = artwork.normalizeKeyboard(keyboardSelect.value);
      keyboardSelect.disabled = true;
      try {
        const settings = await loadSheetsSettings();
        const scenes = { ...(settings.visualizer_scenes || {}) };
        scenes[style] = { ...(scenes[style] || {}), keyboard: value };
        await saveSheetsSettings({ ...settings, visualizer_scenes: scenes });
      } catch (error) {
        toolStatus('Could not save keyboard style: ' + (error.message || error));
        keyboardSelect.value = artwork.normalizeKeyboard(loadSheetsSettingsSync().visualizer_scenes?.[style]?.keyboard);
      } finally {
        keyboardSelect.disabled = false;
      }
    });
  }

  function setVisualStyle(value) {
    if (visualStyle !== artwork.normalize(value)) {
      crayonTime = 0;
    }
    visualStyle = artwork.normalize(value);
    if (styleSelect) styleSelect.value = visualStyle;
    if (keyboardSelect) keyboardSelect.value = artwork.normalizeKeyboard(loadSheetsSettingsSync().visualizer_scenes?.[visualStyle]?.keyboard);
    content.style.setProperty('--pv-accent', artwork.styles[visualStyle].accent);
    particles.length = 0;
    if (!modal.classList.contains('hidden')) renderFrame();
  }
  window.addEventListener('piano-style-change', event => { setVisualStyle(event.detail); updateHandToggles(); });

  // ─── Lazy loading of heavy CDN libraries ─────────────────────────────
  // @tonejs/midi + libfluidsynth WASM (~2 MB) are only needed when the
  // visualizer is actually opened, so they are injected on first use
  // instead of blocking the initial page load.
  const CDN_LIBS = [
    '/converter/Midi.js',
    '/converter/libfluidsynth-2.3.0.js',
    '/converter/js-synthesizer.js',
  ];
  let synthLibsPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  function ensureLibsLoaded() {
    return window.MidiDownloads.ensureLibrary();
  }

  function ensureSynthLibsLoaded() {
    if (!synthLibsPromise) {
      // libfluidsynth must load before js-synthesizer.
      synthLibsPromise = CDN_LIBS.slice(1).reduce(
        (chain, src) => chain.then(() => loadScript(src)),
        Promise.resolve()
      ).catch(err => { synthLibsPromise = null; throw err; });
    }
    return synthLibsPromise;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────
  function formatTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function showLoading(text, pct) {
    if (loadingEl)   loadingEl.classList.remove('hidden');
    if (loadingText) loadingText.textContent = text || 'Loading...';
    if (loadingBar)  loadingBar.style.width = (pct || 0) + '%';
  }

  function hideLoading() {
    if (loadingEl) loadingEl.classList.add('hidden');
  }

  function updateTransportUI() {
    if (btnPlay) {
      const shouldPause = isPlaying && !isPaused;
      btnPlay.classList.toggle('active', shouldPause);
      btnPlay.innerHTML = shouldPause ? '&#10074;&#10074;' : '&#9654;';
      btnPlay.title = shouldPause ? 'Pause' : 'Play';
      btnPlay.setAttribute('aria-label', shouldPause ? 'Pause' : 'Play');
    }
  }

  function isBlackKey(n) {
    const m = n % 12;
    return m === 1 || m === 3 || m === 6 || m === 8 || m === 10;
  }

  function finiteNumber(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function clamp01(value) {
    return clamp(finiteNumber(value, 0), 0, 1);
  }

  function clampMidi7(value) {
    return Math.round(clamp(finiteNumber(value, 0), 0, 127));
  }

  function cloneMidiBuffer() {
    return midiArrayBuffer ? midiArrayBuffer.slice(0) : null;
  }

  function applySustainPedalToNotes(fallbackEnd) {
    const EPS = 0.0001;
    const rangesByChannel = new Map();
    const cc64ByChannel = new Map();

    allCCEvents.forEach(ev => {
      if (ev.cc !== 64) return;
      if (!cc64ByChannel.has(ev.ch)) cc64ByChannel.set(ev.ch, []);
      cc64ByChannel.get(ev.ch).push(ev);
    });

    cc64ByChannel.forEach((events, ch) => {
      events.sort((a, b) => a.time - b.time);
      const ranges = [];
      let isDown = false;
      let downStart = 0;

      events.forEach(ev => {
        const nextDown = ev.value >= 64;
        if (nextDown && !isDown) {
          downStart = ev.time;
          isDown = true;
        } else if (!nextDown && isDown) {
          if (ev.time > downStart + EPS) ranges.push({ start: downStart, end: ev.time });
          isDown = false;
        }
      });

      if (isDown && fallbackEnd > downStart + EPS) {
        ranges.push({ start: downStart, end: fallbackEnd });
      }
      rangesByChannel.set(ch, ranges);
    });

    const notesByChannel = new Map();
    allNotes.forEach(note => {
      note.releaseEnd = note.end;
      note.sustained = false;
      if (!notesByChannel.has(note.channel)) notesByChannel.set(note.channel, []);
      notesByChannel.get(note.channel).push(note);
    });

    notesByChannel.forEach((notes, ch) => {
      const ranges = rangesByChannel.get(ch);
      if (!ranges || ranges.length === 0) return;

      notes.sort((a, b) => a.end - b.end);
      let ri = 0;
      notes.forEach(note => {
        while (ri < ranges.length && ranges[ri].end <= note.end + EPS) ri++;
        const range = ranges[ri];
        if (range && range.start <= note.end + EPS && note.end < range.end - EPS) {
          note.releaseEnd = Math.max(note.releaseEnd, range.end);
          note.sustained = true;
        }
      });
    });
  }

  // ─── Volume ──────────────────────────────────────────────────────────
  function setVolume(v) {
    if (gainNode) gainNode.gain.value = v;
    if (volumeSlider) volumeSlider.style.setProperty('--volume-pct', (v * 100) + '%');
    if (volumeIcon) volumeIcon.textContent = v === 0 ? '🔇' : v < 0.4 ? '🔉' : '🔊';
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => setVolume(parseFloat(volumeSlider.value)));
  }
  if (volumeIcon) {
    let prevVol = 0.8;
    volumeIcon.addEventListener('click', () => {
      if (parseFloat(volumeSlider.value) > 0) {
        prevVol = parseFloat(volumeSlider.value);
        volumeSlider.value = 0;
      } else {
        volumeSlider.value = prevVol;
      }
      setVolume(parseFloat(volumeSlider.value));
    });
  }

  // ─── SoundFont list ──────────────────────────────────────────────────
  async function loadSoundFontList(selectedUrl = '') {
    try {
      const res = await fetch('/api/soundfonts');
      const data = await res.json();
      if (!sfSelect || !data.soundfonts) return;
      sfSelect.innerHTML = '';
      data.soundfonts.forEach(sf => {
        const opt = document.createElement('option');
        opt.value = sf.url;
        opt.textContent = sf.filename.replace(/\.sf2$/i, '') + (sf.size ? ` (${Math.round(sf.size / 1048576)} MB)` : '');
        sfSelect.appendChild(opt);
      });
      sfSelect.add(new Option('Basic synth (fast)', BUILTIN_PIANO));
      let preferred = selectedUrl;
      if(!preferred)try { preferred = (await loadSheetsSettings()).visualizer_soundfont || ''; } catch (_) {}
      if (!preferred) try { preferred = localStorage.getItem('pianoSoundFontUrl') || ''; } catch (_) {}
      sfSelect.value = data.soundfonts.find(sf => sf.url === preferred)?.url
        || BUILTIN_PIANO;
    } catch (e) {
      console.error('Failed to load soundfont list:', e);
      sfSelect?.replaceChildren(new Option('Basic synth (fast)', BUILTIN_PIANO));
    }
  }
  window.refreshPianoSoundFonts=async selectedUrl=>{await loadSoundFontList(selectedUrl);sfSelect?.dispatchEvent(new Event('change'));};

  if (sfSelect) {
    sfSelect.addEventListener('change', async () => {
      try { localStorage.setItem('pianoSoundFontUrl', sfSelect.value); } catch (_) {}
      try {
        if (sfSelect.value === BUILTIN_PIANO) localStorage.setItem('pianoBuiltinExplicit', '1');
        else localStorage.removeItem('pianoBuiltinExplicit');
      } catch (_) {}
      const selectedUrl = sfSelect.value;
      Promise.resolve().then(async () => {
        const settings = await loadSheetsSettings();
        await saveSheetsSettings({ ...settings, visualizer_soundfont: selectedUrl });
      }).catch(error => console.warn('Could not remember SoundFont selection:', error));
      if (midi && sfSelect.value !== currentSfUrl) {
        const revision = openRevision;
        const resumeAt = currentPlayTime();
        const shouldResume = isPlaying && !isPaused;
        const shouldStayPaused = isPaused;
        if (isPlaying) stopPlayback(false);

        await loadSoundFont(sfSelect.value);

        if (revision !== openRevision || selectedUrl !== sfSelect.value || !visualizerActive) return;
        if (shouldResume) {
          startPlayback(resumeAt);
        } else if (shouldStayPaused) {
          pauseOffset = resumeAt;
          isPlaying = true;
          isPaused = true;
          updateTransportUI();
          renderFrame();
        }
      }
    });
  }

  // ─── Audio setup ─────────────────────────────────────────────────────
  async function initAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    gainNode.connect(audioCtx.destination);
    setVolume(volumeSlider ? parseFloat(volumeSlider.value) : 0.8);
  }

  async function initSynth() {
    if (synth) return;
    showLoading('Init Audio Context...', 10);
    await initAudio();
    await ensureSynthLibsLoaded();

    if (typeof JSSynth === 'undefined') throw new Error('js-synthesizer not loaded');

    showLoading('Waiting for JSSynth WASM...', 11);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('WASM init timeout')), 10000));
    await Promise.race([JSSynth.waitForReady(), timeout]);

    showLoading('Creating Synth...', 12);
    synth = new JSSynth.Synthesizer();
    synth.init(audioCtx.sampleRate, { midiChannelCount: 48 });
    for (let ch = 16; ch < 48; ch++) synth.setChannelType(ch, false);

    showLoading('Creating Audio Node...', 13);
    const node = synth.createAudioNode(audioCtx, 8192);
    node.connect(gainNode);
  }

  function unloadCurrentSoundFont() {
    if (currentSfId >= 0 && synth) {
      try { synth.unloadSFont(currentSfId); } catch (error) { console.warn('Could not unload SoundFont:', error); }
      currentSfId = -1;
    }
  }

  async function loadSoundFont(url) {
    while (soundFontLoad) {
      if (soundFontLoadingUrl === url) return soundFontLoad;
      await soundFontLoad;
    }
    if (synthReady && currentSfUrl === url) { hideLoading(); return; }
    soundFontLoadingUrl = url;
    soundFontLoad = loadSoundFontData(url);
    try { await soundFontLoad; } finally { soundFontLoad = null; }
  }

  async function loadSoundFontData(url) {
    showLoading('Loading SoundFont...', 10);
    try {
      if (url === BUILTIN_PIANO) {
        await initAudio();
        unloadCurrentSoundFont();
        currentSfUrl = BUILTIN_PIANO;
        synthReady = true;
        hideLoading();
        return;
      }
      await initSynth();
      unloadCurrentSoundFont();
      const response = await fetch(url,{headers:{Range:'bytes=0-8388607'}});
      if (!response.ok) throw new Error('SoundFont fetch failed: ' + response.status);
      let sfBuffer;
      if(response.status===206){
        const match=/^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range')||'');
        if(!match)throw new Error('Invalid SoundFont byte range.');
        const total=Number(match[2]);const data=new Uint8Array(total);
        let part=await response.arrayBuffer();let offset=Number(match[1])+1;
        if(part.byteLength!==offset)throw new Error('Incomplete SoundFont byte range.');
        data.set(new Uint8Array(part));
        while(offset<total){
          const end=Math.min(offset+8388607,total-1);
          const next=await fetch(url,{headers:{Range:`bytes=${offset}-${end}`}});
          if(next.status!==206||next.headers.get('Content-Range')!==`bytes ${offset}-${end}/${total}`)throw new Error('Invalid SoundFont byte range.');
          part=await next.arrayBuffer();if(part.byteLength!==end-offset+1)throw new Error('Incomplete SoundFont byte range.');
          data.set(new Uint8Array(part),offset);offset=end+1;
          showLoading('Loading SoundFont... '+Math.round(offset/1048576)+' MB',10+Math.round(offset/total*80));
        }
        sfBuffer=data.buffer;
      }else{
        sfBuffer = await response.arrayBuffer();
      }

      showLoading('Initializing synthesizer...', 92);
      currentSfId = await synth.loadSFont(sfBuffer);
      currentSfUrl = url;
      synthReady = true;
      showLoading('Ready', 100);
      setTimeout(hideLoading, 400);
    } catch (e) {
      console.error('SoundFont load error:', e);
      currentSfUrl = '';
      synthReady = false;
      showLoading('SoundFont could not load: ' + (e.message || e), 0);
      toolStatus('Choose Basic synth or another SoundFont, or reopen the visualizer to retry.');
    }
  }

  // ─── MIDI parsing ────────────────────────────────────────────────────
  async function loadMidi(filename, revision) {
    showLoading('Fetching MIDI...', 5);
    if (typeof Midi === 'undefined') throw new Error('@tonejs/midi not loaded');

    const url = '/api/midi/' + encodeURIComponent(filename);
    const res = await fetch(url);
    if (!res.ok) throw new Error('MIDI fetch failed: ' + res.status);
    const buffer = await res.arrayBuffer();
    const storageKey = await enhancements.storageKey(buffer);
    if (revision !== openRevision) return;
    midiArrayBuffer = buffer;
    handStorageKey = storageKey;
    const midiObj = new Midi(cloneMidiBuffer());

    midi = midiObj;
    totalDuration = finiteNumber(midi.duration, 0);
    showLoading('Extracting notes...', 9);

    allNotes        = [];
    allCCEvents     = [];
    pitchBendEvents = [];
    let eventEnd = totalDuration;

    midi.tracks.forEach((track, ti) => {
      // Use the track's real MIDI channel (falls back to track index if unavailable)
      const ch = (track.channel !== undefined && track.channel !== null)
        ? track.channel : ti % 16;

      // Notes — velocity stored as 0..1 by @tonejs/midi (original / 127)
      track.notes.forEach((n, ni) => {
        const start = finiteNumber(n.time, 0);
        const duration = Math.max(0, finiteNumber(n.duration, 0));
        const end = start + duration;
        eventEnd = Math.max(eventEnd, end);
        allNotes.push({
          id: ti + ':' + ni,
          piano: !track.instrument.percussion && track.instrument.number < 8,
          namedHand: enhancements.namedHand(track.name),
          start,
          end,
          releaseEnd: end,
          midi:     n.midi,
          velocity: clamp01(n.velocity),
          channel:  ch,
          track:    ti,
          sustained: false,
        });
      });

      // All control changes (sustain CC64, mod CC1, vol CC7, pan CC10, expr CC11, …)
      if (track.controlChanges) {
        Object.entries(track.controlChanges).forEach(([ccStr, events]) => {
          const cc = parseInt(ccStr, 10);
          events.forEach(ev => {
            const time = finiteNumber(ev.time, 0);
            eventEnd = Math.max(eventEnd, time);
            allCCEvents.push({
              time,
              ch,
              cc,
              value: clampMidi7(clamp01(ev.value) * 127),
            });
          });
        });
      }

      // Pitch bend — @tonejs/midi normalizes by /8192
      if (track.pitchBends) {
        track.pitchBends.forEach(pb => {
          const time = finiteNumber(pb.time, 0);
          eventEnd = Math.max(eventEnd, time);
          pitchBendEvents.push({
            time,
            ch,
            value: Math.round(pb.value * 8192),
          });
        });
      }
    });

    totalDuration = Math.max(totalDuration, eventEnd);
    applySustainPedalToNotes(totalDuration);

    allNotes.sort((a, b) => a.start - b.start);
    handEstimates = enhancements.estimateHands(allNotes);
    handOverrides = enhancements.readOverrides(handStorageKey, handEstimates);
    selectedNoteId = null;
    allCCEvents.sort((a, b) => a.time - b.time);
    pitchBendEvents.sort((a, b) => a.time - b.time);
    maxNoteDuration = 0;
    allNotes.forEach(note => {
      totalDuration = Math.max(totalDuration, note.releaseEnd);
      maxNoteDuration = Math.max(maxNoteDuration, note.end - note.start);
    });

    // Always render a full 88-key piano, from A0 to C8.
    minNote = PIANO_MIN_NOTE;
    maxNote = PIANO_MAX_NOTE;
    if (seekBar) { seekBar.max = totalDuration; seekBar.value = 0; }
    if (editingHands) refreshNoteChoices();

    console.log(`[PianoViz] notes=${allNotes.length} CC=${allCCEvents.length} PB=${pitchBendEvents.length} dur=${totalDuration.toFixed(1)}s`);
  }

  // ─── Piano key layout ────────────────────────────────────────────────
  function computeKeyLayout(canvasW, blackRatio = layoutBlackRatio) {
    layoutBlackRatio = blackRatio;
    pianoKeyLayout = [];
    whiteKeyCount  = 0;
    for (let n = minNote; n <= maxNote; n++) {
      if (!isBlackKey(n)) whiteKeyCount++;
    }
    if (whiteKeyCount === 0) whiteKeyCount = 1;

    const wkw = canvasW / whiteKeyCount;
    const bkw = wkw * blackRatio;

    // First pass: white keys
    let wi = 0;
    for (let n = minNote; n <= maxNote; n++) {
      if (!isBlackKey(n)) {
        pianoKeyLayout[n] = { x: wi * wkw, width: wkw, isBlack: false };
        wi++;
      }
    }

    // Second pass: black keys centered between neighboring whites
    for (let n = minNote; n <= maxNote; n++) {
      if (!isBlackKey(n)) continue;
      let lw = n - 1; while (lw >= minNote && isBlackKey(lw)) lw--;
      let rw = n + 1; while (rw <= maxNote && isBlackKey(rw)) rw++;

      if (pianoKeyLayout[lw] && pianoKeyLayout[rw]) {
        const cx = ((pianoKeyLayout[lw].x + pianoKeyLayout[lw].width / 2) +
                    (pianoKeyLayout[rw].x + pianoKeyLayout[rw].width / 2)) / 2;
        pianoKeyLayout[n] = { x: cx - bkw / 2, width: bkw, isBlack: true };
      } else if (pianoKeyLayout[lw]) {
        pianoKeyLayout[n] = { x: pianoKeyLayout[lw].x + pianoKeyLayout[lw].width - bkw / 2, width: bkw, isBlack: true };
      } else if (pianoKeyLayout[rw]) {
        pianoKeyLayout[n] = { x: pianoKeyLayout[rw].x - bkw / 2, width: bkw, isBlack: true };
      }
    }
  }

  // ─── Master clock ────────────────────────────────────────────────────
  function currentPlayTime() {
    if (!isPlaying || isPaused || playbackStarting) return pauseOffset;
    const t = audioCtx
      ? audioCtx.currentTime - audioStartCtxTime + audioStartMidiTime
      : performance.now() / 1000 - startTimeFallback;
    return clamp(t, 0, totalDuration || t);
  }

  function stopLitePlayer() {
    if (liteTimer) clearInterval(liteTimer);
    liteTimer = null;
    for (const voice of liteVoices) {
      try { voice.oscillator.stop(); } catch (_) {}
    }
    liteVoices.clear();
  }

  function startLitePlayer(offset) {
    stopLitePlayer();
    let nextNote = 0;
    const startedAt = audioCtx.currentTime;
    const schedule = () => {
      const horizon = offset + audioCtx.currentTime - startedAt + 0.18;
      while (nextNote < allNotes.length && allNotes[nextNote].start <= horizon) {
        const note = allNotes[nextNote++];
        const hand = note.hand || handFor(note);
        if (!handEnabled[hand] || note.releaseEnd <= offset || note.velocity <= 0) continue;
        const begins = Math.max(audioCtx.currentTime, startedAt + note.start - offset);
        const ends = Math.max(begins + 0.02, startedAt + note.releaseEnd - offset);
        const oscillator = audioCtx.createOscillator();
        const envelope = audioCtx.createGain();
        oscillator.type = 'triangle';
        oscillator.frequency.value = 440 * Math.pow(2, (note.midi - 69) / 12);
        oscillator.connect(envelope);
        envelope.connect(gainNode);
        const level = 0.12 * note.velocity;
        envelope.gain.setValueAtTime(0, begins);
        envelope.gain.linearRampToValueAtTime(level, begins + 0.012);
        envelope.gain.exponentialRampToValueAtTime(Math.max(level * 0.28, 0.0001), Math.min(ends, begins + 0.45));
        envelope.gain.setTargetAtTime(0.0001, ends, 0.08);
        const voice = { oscillator, hand };
        oscillator.onended = () => { liteVoices.delete(voice); oscillator.disconnect(); envelope.disconnect(); };
        liteVoices.add(voice);
        oscillator.start(begins);
        oscillator.stop(ends + 0.35);
      }
    };
    schedule();
    liteTimer = setInterval(schedule, 40);
  }

  // ─── Transport ───────────────────────────────────────────────────────
  function stopFluidPlayer() {
    playbackToken++;
    stopLitePlayer();
    if (!synth) return;
    try { synth.stopPlayer(); } catch(e) {}
    if (playerHooked) {
      // Release the WASM callback and its note queues before closing a file.
      try { synth.hookPlayerMIDIEvents(null); } catch(e) {}
      playerHooked = false;
    }
    // Remove the stopped player's sample timer as well. With an event hook,
    // leaving it attached can dispatch stale callbacks on later audio blocks.
    try { synth.closePlayer(); } catch(e) {}
    try { synth.midiAllSoundsOff(-1); } catch(e) {}
  }

  async function startPlayback(fromTime) {
    if (!synthReady || !midiArrayBuffer || (currentSfUrl !== BUILTIN_PIANO && !synth)) return false;

    isScrubbing = false;
    seekWasPlaying = false;
    stopFluidPlayer();
    const token = ++playbackToken;
    pauseOffset = clamp(finiteNumber(fromTime, 0), 0, totalDuration || 0);
    isPlaying = true;
    isPaused = false;
    playbackStarting = true;
    updateTransportUI();

    try {
      if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
      if (token !== playbackToken) return;

      if (currentSfUrl === BUILTIN_PIANO) {
        audioStartCtxTime = audioCtx.currentTime;
        audioStartMidiTime = pauseOffset;
        startTimeFallback = performance.now() / 1000 - pauseOffset;
        startLitePlayer(pauseOffset);
        playbackStarting = false;
        updateTransportUI();
        startRenderLoop();
        return true;
      }

      await synth.resetPlayer();
      if (token !== playbackToken) return;

      const segment = pauseOffset > 0
        ? enhancements.segmentAt(midi, pauseOffset, currentHands())
        : { data: cloneMidiBuffer(), notes: allNotes };
      await synth.addSMFDataToPlayer(segment.data);
      synth.hookPlayerMIDIEvents(enhancements.createHandRouter(segment.notes,
        note => note.hand || handFor(note), hand => handEnabled[hand]));
      playerHooked = true;
      if (token !== playbackToken) return;

      await synth.playPlayer();
      if (token !== playbackToken) return;
      audioStartCtxTime = audioCtx ? audioCtx.currentTime : 0;
      audioStartMidiTime = pauseOffset;
      startTimeFallback = performance.now() / 1000 - pauseOffset;
      playbackStarting = false;

      if (typeof synth.waitForPlayerStopped === 'function') {
        synth.waitForPlayerStopped().then(() => {
          if (token === playbackToken && isPlaying && !isPaused && !recording) stopPlayback();
        });
      }

      updateTransportUI();
      startRenderLoop();
      return true;
    } catch (e) {
      if (token === playbackToken) {
        console.error('Piano visualizer playback error:', e);
        isPlaying = false;
        isPaused = false;
        playbackStarting = false;
        pauseOffset = 0;
        stopFluidPlayer();
        updateTransportUI();
        showLoading('Playback error: ' + (e.message || e), 0);
      }
      return false;
    }
  }

  function pausePlayback() {
    if (!isPlaying) return;
    pauseOffset = currentPlayTime();
    isPaused = true;
    stopFluidPlayer();
    updateTransportUI();
    renderFrame();
  }

  function resumePlayback() {
    if (!isPaused) return;
    startPlayback(pauseOffset);
  }

  function stopPlayback(resetOffset = true) {
    if (recording) finishVideoRender(currentPlayTime() < totalDuration - 0.15);
    isPlaying = false;
    isPaused = false;
    playbackStarting = false;
    if (resetOffset) {
      pauseOffset = 0;
      isScrubbing = false;
      seekWasPlaying = false;
    }
    stopFluidPlayer();
    updateTransportUI();
    renderFrame();
  }

  // ─── Transport buttons ───────────────────────────────────────────────
  if (btnPlay) {
    btnPlay.addEventListener('click', () => {
      if (isPlaying && !isPaused) pausePlayback();
      else if (isPaused) resumePlayback();
      else startPlayback(pauseOffset);
    });
  }
  if (btnStop)  btnStop.addEventListener('click', () => stopPlayback());

  const renderButton = tool('render-video');
  function setRenderControlsBusy(busy) {
    [btnPlay, btnStop, seekBar, sfSelect, styleSelect, keyboardSelect,
      tool('toggle-left'), tool('toggle-right'), tool('edit-hands')].forEach(control => {
      if (control) control.disabled = busy;
    });
  }
  function finishVideoRender(cancelled = false) {
    const job = recording;
    if (!job) return;
    recording = null;
    job.cancelled = cancelled;
    renderButton.textContent = 'Render video';
    setRenderControlsBusy(false);
    if (job.recorder.state !== 'inactive') job.recorder.stop();
  }
  if (renderButton) renderButton.addEventListener('click', async () => {
    if (recording) { finishVideoRender(true); stopPlayback(); toolStatus('Video render cancelled.'); return; }
    if (!midi || !synthReady || !gainNode || !window.MediaRecorder || !canvas.captureStream) {
      toolStatus('Video recording is unavailable in this browser or audio is not ready.'); return;
    }
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) { toolStatus('This browser cannot record WebM video.'); return; }
    stopPlayback();
    const videoStream = canvas.captureStream(30);
    const audioDestination = audioCtx.createMediaStreamDestination();
    gainNode.connect(audioDestination);
    const stream = new MediaStream([...videoStream.getVideoTracks(), ...audioDestination.stream.getAudioTracks()]);
    const chunks = [];
    let recorder;
    try { recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 }); }
    catch (error) {
      gainNode.disconnect(audioDestination); stream.getTracks().forEach(track => track.stop());
      toolStatus('Could not start video recording: ' + error.message); return;
    }
    const job = { recorder, cancelled: false, filename: currentFilename };
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => {
      if (recording === job) finishVideoRender(true);
      stopPlayback();
      toolStatus('Video recording failed.');
    };
    recorder.onstop = () => {
      gainNode.disconnect(audioDestination);
      stream.getTracks().forEach(track => track.stop());
      if (job.cancelled || !chunks.length) return;
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = (job.filename.replace(/\.(mid|midi)$/i, '') || 'visualizer') + '-visualizer.webm';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toolStatus('Video saved as WebM with audio.');
    };
    recording = job;
    setRenderControlsBusy(true);
    renderButton.textContent = 'Cancel render';
    toolStatus('Rendering in real time. Keep this tab visible.');
    recorder.start(1000);
    const started = await startPlayback(0);
    if (!started && recording === job) { finishVideoRender(true); toolStatus('Playback could not start; video render cancelled.'); }
  });

  if (seekBar) {
    seekBar.addEventListener('input', () => {
      const t = parseFloat(seekBar.value);
      if (!isScrubbing) {
        isScrubbing = true;
        seekWasPlaying = isPlaying && !isPaused;
        if (seekWasPlaying) stopPlayback(false);
      }
      pauseOffset = clamp(finiteNumber(t, 0), 0, totalDuration || 0);
      renderFrame();
    });
    seekBar.addEventListener('change', () => {
      if (!isScrubbing) return;
      isScrubbing = false;
      if (seekWasPlaying) {
        seekWasPlaying = false;
        startPlayback(pauseOffset);
      }
    });
  }

  function closeModal() {
    stopPlayback();
    if (sceneMedia?.tagName === 'VIDEO') sceneMedia.pause();
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
    modal.classList.add('hidden');
  }
  if (btnClose) btnClose.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', e => {
    if (modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      closeModal();
    }
    if (e.target.closest('input, select, button, textarea, [contenteditable="true"]')) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (isPlaying && !isPaused) pausePlayback();
      else if (isPaused) resumePlayback();
      else startPlayback(pauseOffset);
    }
  });

  // ─── Canvas resize ───────────────────────────────────────────────────
  function getStageSize() {
    const stage = canvas ? canvas.parentElement : null;
    if (!stage) return { width: 0, height: 0 };
    const rect = stage.getBoundingClientRect();
    return {
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    };
  }

  function resizeCanvas() {
    if (!canvas || !ctx) return false;

    const size = getStageSize();
    if (size.width <= 0 || size.height <= 0) return false;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const bitmapW = Math.max(1, Math.round(size.width * dpr));
    const bitmapH = Math.max(1, Math.round(size.height * dpr));

    if (
      canvas.width === bitmapW &&
      canvas.height === bitmapH &&
      canvasCssWidth === size.width &&
      canvasCssHeight === size.height
    ) {
      return false;
    }

    canvasCssWidth = size.width;
    canvasCssHeight = size.height;
    canvas.width = bitmapW;
    canvas.height = bitmapH;
    canvas.style.width = size.width + 'px';
    canvas.style.height = size.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    computeKeyLayout(size.width);
    return true;
  }

  function scheduleCanvasResize() {
    if (modal.classList.contains('hidden')) return;
    if (resizeRafId) cancelAnimationFrame(resizeRafId);
    resizeRafId = requestAnimationFrame(() => {
      resizeRafId = null;
      resizeCanvas();
      renderFrame();
    });
  }
  window.addEventListener('resize', scheduleCanvasResize);

  if (window.ResizeObserver && canvas.parentElement) {
    const stageResizeObserver = new ResizeObserver(scheduleCanvasResize);
    stageResizeObserver.observe(canvas.parentElement);
  }

  // ─── Render loop ─────────────────────────────────────────────────────
  // Cached background gradient (rebuilt only when canvas size changes)
  let bgGradient = null;
  let bgGradientKey = '';
  let sceneMediaKey = '';
  let sceneMedia = null;
  let sceneMediaPlayPending = false;

  function drawSceneMedia(scene, width, height) {
    const url = scene.media_url;
    if (typeof url !== 'string' || !/^\/visualizer-backgrounds\/[0-9a-f]{32}\.(?:jpg|jpeg|png|webp|gif|mp4|webm|mov)$/.test(url)) return false;
    const type = scene.media_type;
    if (type !== 'image' && type !== 'video') return false;
    const key = type + ':' + url;
    if (sceneMediaKey !== key) {
      if (sceneMedia?.tagName === 'VIDEO') { sceneMedia.pause(); sceneMedia.removeAttribute('src'); sceneMedia.load(); }
      sceneMediaKey = key;
      sceneMediaPlayPending = false;
      sceneMedia = type === 'image' ? new Image() : document.createElement('video');
      if (type === 'image') sceneMedia.onload = renderFrame;
      else {
        sceneMedia.muted = true; sceneMedia.loop = true; sceneMedia.playsInline = true;
        sceneMedia.preload = 'auto';
      }
      sceneMedia.src = url;
    }
    if (type === 'video' && !reduceMotion.matches && !modal.classList.contains('hidden') && sceneMedia.paused && !sceneMediaPlayPending) {
      sceneMediaPlayPending = true;
      sceneMedia.play().catch(() => {}).finally(() => { sceneMediaPlayPending = false; });
    }
    if (type === 'video' && reduceMotion.matches && !sceneMedia.paused) sceneMedia.pause();
    const mediaWidth = type === 'image' ? sceneMedia.naturalWidth : sceneMedia.videoWidth;
    const mediaHeight = type === 'image' ? sceneMedia.naturalHeight : sceneMedia.videoHeight;
    if (!mediaWidth || !mediaHeight) return false;
    const scale = Math.max(width / mediaWidth, height / mediaHeight);
    const drawWidth = mediaWidth * scale, drawHeight = mediaHeight * scale;
    ctx.drawImage(sceneMedia, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    return true;
  }

  // Spark particles rising from active keys
  const MAX_PARTICLES = 150;
  const particles = [];
  let lastFrameTs = 0;
  let crayonTime = 0;

  function lowerBoundByStart(value) {
    let lo = 0, hi = allNotes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (allNotes[mid].start < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function spawnParticles(kl, col, velocity, playheadY, dt) {
    if (particles.length >= MAX_PARTICLES) return;
    let count = (10 + velocity * 35) * dt;
    while (count > 0 && particles.length < MAX_PARTICLES) {
      if (count < 1 && Math.random() > count) break;
      particles.push({
        x: kl.x + Math.random() * kl.width,
        y: playheadY - Math.random() * 3,
        vx: (Math.random() - 0.5) * 20,
        vy: -(35 + Math.random() * 75) * (0.6 + velocity * 0.8),
        life: 1,
        decay: 1.1 + Math.random() * 1.5,
        size: 1 + Math.random() * 2,
        col,
      });
      count -= 1;
    }
  }

  function updateAndDrawParticles(dt) {
    if (particles.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    let w = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.life -= p.decay * dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.fillStyle = `rgba(${p.col[0]},${p.col[1]},${p.col[2]},${p.life * 0.85})`;
      ctx.fillRect(p.x, p.y, p.size, p.size);
      particles[w++] = p;
    }
    particles.length = w;
    ctx.restore();
  }

  function startRenderLoop() {
    if (!visualizerActive || animFrameId) return;
    lastFrameTs = performance.now();
    function frame() { animFrameId = requestAnimationFrame(frame); renderFrame(); }
    frame();
  }

  function renderFrame() {
    if (!ctx || !canvas) return;
    resizeCanvas();
    const W = canvasCssWidth;
    const H = canvasCssHeight;
    if (W <= 0 || H <= 0) return;

    const now = performance.now();
    const dt = clamp((now - lastFrameTs) / 1000, 0, 0.05);
    lastFrameTs = now;

    const viewSettings = loadSheetsSettingsSync();
    const PPS          = clamp(Number(viewSettings.visualizer_speed) || 200, 50, 800);
    const theme        = artwork.styles[visualStyle];
    const PIANO_HEIGHT = Math.min(120, Math.max(60, H * 0.18));
    const BK_RATIO     = 0.63;
    const playheadY    = H - PIANO_HEIGHT;
    const noteAreaH    = playheadY;

    const t = currentPlayTime();
    const animating = isPlaying && !isPaused;
    const animateCrayon = (visualStyle === 'crayon' || visualStyle === 'sketch') && !reduceMotion.matches;
    if (animateCrayon && !isPaused && !document.hidden && !modal.classList.contains('hidden')) crayonTime += dt;

    // ── Background (cached vertical gradient) ──
    const scene = viewSettings.visualizer_scenes?.[visualStyle] || {};
    const keyboardStyle = artwork.normalizeKeyboard(scene.keyboard);
    const blackRatio = keyboardStyle === 'ivory' ? 0.46 : 0.58;
    if (layoutBlackRatio !== blackRatio) computeKeyLayout(W, blackRatio);
    const sceneMode = ['solid', 'spotlight', 'image', 'video'].includes(scene.mode || viewSettings.visualizer_background) ? (scene.mode || viewSettings.visualizer_background) : 'theme';
    const requestedColor = scene.color || viewSettings.visualizer_background_color;
    const sceneColor = /^#[0-9a-f]{6}$/i.test(requestedColor) ? requestedColor : '#172033';
    const gradKey = W + 'x' + H + visualStyle + sceneMode + sceneColor;
    if (!bgGradient || bgGradientKey !== gradKey) {
      if (sceneMode === 'solid') bgGradient = sceneColor;
      else if (sceneMode === 'spotlight') {
        bgGradient = ctx.createRadialGradient(W * 0.5, H * 0.22, 0, W * 0.5, H * 0.3, Math.max(W, H) * 0.75);
        bgGradient.addColorStop(0, sceneColor);
        bgGradient.addColorStop(1, theme.background[2]);
      } else {
        bgGradient = ctx.createLinearGradient(0, 0, 0, H);
        bgGradient.addColorStop(0, theme.background[0]);
        bgGradient.addColorStop(0.55, theme.background[1]);
        bgGradient.addColorStop(1, theme.background[2]);
      }
      bgGradientKey = gradKey;
    }
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, W, H);
    const hasMedia = (sceneMode === 'image' || sceneMode === 'video') && drawSceneMedia(scene, W, H);
    if (hasMedia) {
      ctx.fillStyle = `rgba(0,0,0,${clamp(Number(scene.dim ?? 25) || 0, 0, 80) / 100})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (sceneMode !== 'image' && sceneMode !== 'video' && sceneMedia?.tagName === 'VIDEO') sceneMedia.pause();
    if (theme.paper && !hasMedia) artwork.paper(ctx, W, H);

    const effect = scene.effect || viewSettings.visualizer_effect;
    const strength = clamp(Number(scene.strength ?? viewSettings.visualizer_effect_strength) || 0, 0, 100) / 100;
    const effectTime = reduceMotion.matches ? 0 : t;
    if (strength > 0 && effect !== 'none') {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W, playheadY); ctx.clip();
      if (effect === 'stars') {
        for (let i = 0; i < 65; i++) {
          const x = ((i * 7919 % 997) / 997 * W + effectTime * (3 + i % 7)) % W;
          const y = (i * 383 % 991) / 991 * playheadY;
          const pulse = reduceMotion.matches ? 0.75 : 0.5 + 0.5 * Math.sin(effectTime * 1.7 + i);
          ctx.fillStyle = `rgba(255,255,255,${(0.08 + pulse * 0.5) * strength})`;
          ctx.beginPath(); ctx.arc(x, y, 0.5 + i % 3, 0, Math.PI * 2); ctx.fill();
        }
      } else if (effect === 'waves') {
        for (let line = 0; line < 5; line++) {
          ctx.strokeStyle = `rgba(160,210,255,${(0.08 + line * 0.025) * strength})`;
          ctx.lineWidth = 1.5 + line * 0.4;
          ctx.beginPath();
          for (let x = 0; x <= W + 8; x += 8) {
            const y = playheadY * (0.18 + line * 0.15) + Math.sin(x / 65 + effectTime * 0.7 + line) * (9 + line * 4);
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      } else if (effect === 'grid') {
        ctx.strokeStyle = `rgba(175,210,255,${0.22 * strength})`;
        ctx.lineWidth = 1;
        const spacing = 42;
        const offset = (effectTime * 25) % spacing;
        for (let y = -spacing + offset; y < playheadY; y += spacing) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }
        for (let x = 0; x < W; x += spacing) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, playheadY); ctx.stroke();
        }
      }
      ctx.restore();
    }

    // ── Vertical octave grid lines ──
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 0.5;
    for (let n = minNote; n <= maxNote; n++) {
      if (n % 12 === 0 && pianoKeyLayout[n]) {
        ctx.beginPath();
        ctx.moveTo(pianoKeyLayout[n].x, 0);
        ctx.lineTo(pianoKeyLayout[n].x, playheadY);
        ctx.stroke();
      }
    }

    // ── Falling notes + active keys (single windowed pass) ──
    // Show the full note area ahead so notes are visible before they play
    const viewStart = t - (noteAreaH / PPS);      // past notes (just scrolled off)
    const viewEnd   = t + (noteAreaH / PPS) + 0.2; // future notes filling canvas top
    const activeKeys = {};
    noteHitboxes = [];
    const colorByHands = viewSettings.hand_color_mode !== 'tracks';
    const handColors = Object.fromEntries(['left', 'right'].map(hand => [hand,
      (viewSettings['hand_' + hand + '_color'] || (hand === 'left' ? '#38bdf8' : '#f472b6')).slice(1).match(/../g).map(v => parseInt(v, 16))]));

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, playheadY); ctx.clip();

    // allNotes is sorted by start: begin at the first note that could still
    // overlap the window and stop as soon as starts pass the window end.
    const iFrom = lowerBoundByStart(viewStart - maxNoteDuration);
    for (let i = iFrom; i < allNotes.length; i++) {
      const note = allNotes[i];
      if (note.start > viewEnd) break;
      // Draw the physical MIDI note only. Sustain is shown on the keyboard
      // highlight below; stretching every note rectangle creates stacked tails.
      if (note.end < viewStart) continue;
      const kl = pianoKeyLayout[note.midi];
      if (!kl) continue;

      const hand = handFor(note);
      if (hand && !handEnabled[hand]) continue;
      const col = colorByHands && hand
        ? handColors[hand]
        : theme.colors[note.track % theme.colors.length];
      const isActive = t >= note.start && t <= note.end;
      if (isActive) {
        const prev = activeKeys[note.midi];
        if (!prev || note.velocity > prev.velocity) {
          activeKeys[note.midi] = { col, velocity: note.velocity };
        }
      }

      const botY = playheadY - (note.start - t) * PPS;
      const topY = playheadY - (note.end   - t) * PPS;
      const nh   = Math.max(3, botY - topY);
      const nx   = kl.x + 1;
      const nw   = Math.max(2, kl.width - 2);
      let motion = null;
      if (animateCrayon && botY >= 0 && topY <= playheadY) {
        motion = { time: crayonTime };
      }
      artwork.note(ctx, visualStyle, nx, topY, nw, nh, col, note.velocity, isActive, i, motion);
      if (editingHands && note.piano && botY >= 0 && topY <= playheadY) {
        noteHitboxes.push({ id: note.id, x: nx, y: Math.max(0, topY), w: nw, h: Math.min(botY, playheadY) - Math.max(0, topY) });
        if (note.id === selectedNoteId) {
          ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.strokeRect(nx, topY, nw, nh);
        }
      }
      if (isActive && animating && theme.particles && viewSettings.visualizer_particles !== false && !reduceMotion.matches) {
        spawnParticles(kl, col, note.velocity, playheadY, dt);
      }
    }
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

    // ── Particles (drawn inside the note-area clip) ──
    updateAndDrawParticles(animating ? dt : 0);
    ctx.restore();

    // ── Playhead glow band + line ──
    if (!theme.paper) {
      const glow = ctx.createLinearGradient(0, playheadY - 26, 0, playheadY);
      glow.addColorStop(0, theme.accent + '00');
      glow.addColorStop(1, theme.accent + '38');
      ctx.fillStyle = glow;
      ctx.fillRect(0, playheadY - 26, W, 26);
    }
    ctx.strokeStyle = theme.accent; ctx.lineWidth = 2;
    ctx.shadowColor = theme.accent; ctx.shadowBlur = theme.paper ? 0 : 10;
    ctx.beginPath(); ctx.moveTo(0, playheadY); ctx.lineTo(W, playheadY); ctx.stroke();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

    // ── Piano keyboard — white keys ──
    const keyboard = artwork.keyboard(keyboardStyle, theme);
    const whiteGrad = ctx.createLinearGradient(0, playheadY, 0, playheadY + PIANO_HEIGHT);
    whiteGrad.addColorStop(0, keyboard.white[0]);
    whiteGrad.addColorStop(0.85, keyboard.white[1]);
    whiteGrad.addColorStop(1, keyboard.white[2]);
    for (let n = minNote; n <= maxNote; n++) {
      const kl = pianoKeyLayout[n];
      if (!kl || kl.isBlack) continue;
      ctx.fillStyle = whiteGrad;
      ctx.fillRect(kl.x, playheadY, kl.width, PIANO_HEIGHT);
      ctx.strokeStyle = keyboard.border; ctx.lineWidth = 1;
      ctx.strokeRect(kl.x, playheadY, kl.width, PIANO_HEIGHT);
      if (activeKeys[n]) {
        const ak = activeKeys[n];
        ctx.fillStyle = `rgba(${ak.col[0]},${ak.col[1]},${ak.col[2]},${0.45 + ak.velocity * 0.45})`;
        ctx.fillRect(kl.x + 1, playheadY + 1, kl.width - 2, PIANO_HEIGHT - 2);
      }
      artwork.keyboardDetail(ctx, keyboardStyle, kl.x, playheadY, kl.width, PIANO_HEIGHT, false);
      if (n % 12 === 0 && viewSettings.visualizer_labels !== false) {
        const octave = Math.floor(n / 12) - 1;
        ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillStyle = activeKeys[n] ? keyboard.activeLabel : keyboard.label;
        ctx.fillText('C' + octave, kl.x + kl.width / 2, playheadY + PIANO_HEIGHT - 3);
      }
    }

    // ── Red felt strip + shadow under the keybed (classic piano look) ──
    ctx.fillStyle = keyboard.felt;
    ctx.fillRect(0, playheadY, W, 3);
    const bedShadow = ctx.createLinearGradient(0, playheadY + 3, 0, playheadY + 12);
    bedShadow.addColorStop(0, 'rgba(0,0,0,0.35)');
    bedShadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bedShadow;
    ctx.fillRect(0, playheadY + 3, W, 9);

    // ── Piano keyboard — black keys ──
    const bkh = PIANO_HEIGHT * BK_RATIO;
    const blackGrad = ctx.createLinearGradient(0, playheadY, 0, playheadY + bkh);
    blackGrad.addColorStop(0, keyboard.black[0]);
    blackGrad.addColorStop(0.15, keyboard.black[1]);
    blackGrad.addColorStop(1, keyboard.black[2]);
    for (let n = minNote; n <= maxNote; n++) {
      const kl = pianoKeyLayout[n];
      if (!kl || !kl.isBlack) continue;
      ctx.fillStyle = blackGrad;
      ctx.fillRect(kl.x, playheadY, kl.width, bkh);
      ctx.strokeStyle = keyboard.black[2]; ctx.lineWidth = 1;
      ctx.strokeRect(kl.x, playheadY, kl.width, bkh);
      if (activeKeys[n]) {
        const ak = activeKeys[n];
        ctx.fillStyle = `rgba(${ak.col[0]},${ak.col[1]},${ak.col[2]},${0.55 + ak.velocity * 0.35})`;
        ctx.fillRect(kl.x + 1, playheadY + 1, kl.width - 2, bkh - 2);
      }
      artwork.keyboardDetail(ctx, keyboardStyle, kl.x, playheadY, kl.width, bkh, true);
    }

    // ── Update controls ──
    if (timeDisplay) timeDisplay.textContent = formatTime(t) + ' / ' + formatTime(totalDuration);
    if (seekBar) {
      seekBar.max   = totalDuration || 1;
      seekBar.value = t;
      seekBar.style.setProperty('--seek-pct', ((t / (totalDuration || 1)) * 100) + '%');
    }
    if (isPlaying && !isPaused && t >= totalDuration) stopPlayback();
  }

  // ─── Public API ──────────────────────────────────────────────────────
  window.openPianoVisualizer = async function (midiFilename) {
    if (!modal || !canvas) { console.error('Piano visualizer DOM not found'); return; }
    const revision = ++openRevision;

    currentFilename = midiFilename;
    handEnabled.left = true; handEnabled.right = true; updateHandToggles();
    setToolsBusy(true);
    crayonTime = 0;
    setVisualStyle(loadSheetsSettingsSync().visualizer_style);
    if (titleEl) titleEl.textContent = midiFilename.replace(/\.(mid|midi)$/i, '');

    stopPlayback();
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
    allNotes = []; allCCEvents = []; pitchBendEvents = []; midiArrayBuffer = null; midi = null;
    minNote = PIANO_MIN_NOTE;
    maxNote = PIANO_MAX_NOTE;

    modal.classList.remove('hidden');
    resizeCanvas();
    showLoading('Initializing...', 0);

    try {
      showLoading('Loading libraries...', 2);
      await ensureLibsLoaded();
      if (revision !== openRevision) return;

      if (sfSelect && !sfSelect.value) await loadSoundFontList();
      if (revision !== openRevision) return;

      await loadMidi(midiFilename, revision);
      if (revision !== openRevision) return;
      resizeCanvas();

      startRenderLoop();
      setToolsBusy(false);

      const sf = sfSelect?.value || BUILTIN_PIANO;
      if (!synthReady || sf !== currentSfUrl) await loadSoundFont(sf);
      else hideLoading();
      if (revision !== openRevision) return;

      if (seekBar) { seekBar.max = totalDuration; seekBar.value = 0; }
      pauseOffset = 0;
      startRenderLoop(); // show notes before play is pressed
    } catch (e) {
      if (revision !== openRevision) return;
      console.error('Piano visualizer error:', e, e.stack);
      if (midi) {
        hideLoading(); toolStatus('MIDI loaded; audio unavailable: ' + (e.message || e));
        startRenderLoop();
      } else showLoading('Error: ' + (e.message || e), 0);
    } finally {
      if (revision === openRevision) setToolsBusy(!midi);
    }
  };

  window.setVisualizerActive = visible => {
    visualizerActive = visible;
    if (!visible) {
      if (recording) finishVideoRender(true);
      if (isPlaying && !isPaused) pausePlayback();
      if (sceneMedia?.tagName === 'VIDEO') sceneMedia.pause();
      if (animFrameId) {cancelAnimationFrame(animFrameId);animFrameId=null;}
    } else if (!modal.classList.contains('hidden')) startRenderLoop();
  };
})();
