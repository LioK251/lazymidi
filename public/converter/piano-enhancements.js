/* Hand estimation and live MIDI routing shared by playback and downloads. */
(function (root) {
  'use strict';
  const mean = notes => notes.reduce((sum, n) => sum + n.midi, 0) / notes.length;
  function namedHand(name) {
    if (/\b(left hand|left|lh)\b/i.test(name)) return 'left';
    if (/\b(right hand|right|rh)\b/i.test(name)) return 'right';
    return null;
  }

  // A small beam search considers chord spans, register, and movement between
  // successive groups. Pitch-ordered splits are a heuristic, not crossing detection.
  function estimateHands(notes) {
    const sorted = notes.filter(n => n.piano !== false).slice().sort((a, b) => a.start - b.start || a.midi - b.midi);
    const groups = [];
    for (const note of sorted) {
      const last = groups[groups.length - 1];
      if (!last || note.start - last[0].start > 0.045) groups.push([note]);
      else last.push(note);
    }
    let beam = [{ cost: 0, left: 48, right: 72, time: -10, path: null }];
    for (const raw of groups) {
      const group = raw.slice().sort((a, b) => a.midi - b.midi);
      const candidates = [];
      for (let split = 0; split <= group.length; split++) {
        const left = group.slice(0, split), right = group.slice(split);
        const spanCost = ns => ns.length ? Math.max(0, ns.at(-1).midi - ns[0].midi - 12) ** 2 * 1.5 + Math.max(0, ns.length - 5) * 8 : 0;
        const register = left.reduce((s, n) => s + Math.max(0, n.midi - 60) * 0.45, 0)
          + right.reduce((s, n) => s + Math.max(0, 60 - n.midi) * 0.45, 0);
        const namedCost = group.reduce((s, n, i) => s + (n.namedHand && n.namedHand !== (i < split ? 'left' : 'right') ? 10000 : 0), 0);
        for (const previous of beam) {
          const continuity = Math.exp(-Math.max(0, group[0].start - previous.time) / 2);
          const movement = (left.length ? Math.abs(mean(left) - previous.left) : 0)
            + (right.length ? Math.abs(mean(right) - previous.right) : 0);
          candidates.push({ cost: previous.cost + register + namedCost + spanCost(left) + spanCost(right) + movement * continuity * 0.65,
            left: left.length ? mean(left) : previous.left, right: right.length ? mean(right) : previous.right,
            time: group[0].start, path: { previous: previous.path, group, split } });
        }
      }
      beam = candidates.sort((a, b) => a.cost - b.cost).slice(0, 6);
    }
    const result = {};
    let path = beam[0].path;
    while (path) {
      path.group.forEach((note, i) => { result[note.id] = note.namedHand || (i < path.split ? 'left' : 'right'); });
      path = path.previous;
    }
    return result;
  }

  function describeNotes(midi) {
    return midi.tracks.flatMap((track, ti) => track.notes.map((n, ni) => ({
      id: ti + ':' + ni, start: n.time, end: n.time + n.duration, midi: n.midi,
      piano: !track.instrument.percussion && track.instrument.number < 8,
      namedHand: namedHand(track.name)
    })));
  }

  function splitHands(midi, hands) {
    const json = JSON.parse(JSON.stringify(midi.toJSON()));
    json.tracks = json.tracks.flatMap((track, ti) => {
      if (track.channel === 9 || track.instrument.number >= 8 || !track.notes.length) return [track];
      const parts = ['left', 'right', null].map(hand => ({ ...track,
        name: hand ? (hand === 'left' ? 'Left Hand' : 'Right Hand') : track.name,
        notes: track.notes.filter((_, ni) => (hands[ti + ':' + ni] || null) === hand)
      })).filter(track => track.notes.length);
      // Keep the original channel/program and copy controllers to both tracks:
      // pedal and other controller events then remain available to either hand.
      return parts;
    });
    return fromJSON(midi, json);
  }

  function fromJSON(midi, json) {
    const output = new midi.constructor();
    output.fromJSON(json);
    // Tone MIDI 2.0.x omits pitch bends in Track.fromJSON, despite exporting
    // them in toJSON. Restore them explicitly for a faithful musical copy.
    output.tracks.forEach((track, i) => {
      track.pitchBends = [];
      (json.tracks[i].pitchBends || []).forEach(bend => track.addPitchBend(bend));
    });
    return output;
  }

  async function storageKey(buffer) {
    let fingerprint;
    if (globalThis.crypto?.subtle) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
      fingerprint = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    } else {
      let a = 2166136261, b = 5381;
      for (const byte of new Uint8Array(buffer)) { a = Math.imul(a ^ byte, 16777619); b = Math.imul(b, 33) ^ byte; }
      fingerprint = `${buffer.byteLength}:${a >>> 0}:${b >>> 0}`;
    }
    return 'piano-hands-v1:' + fingerprint;
  }
  function readOverrides(key, estimates) {
    try {
      const stored = JSON.parse(root.localStorage.getItem(key) || '{}');
      return Object.fromEntries(Object.entries(stored || {}).filter(([id, hand]) => id in estimates && ['left', 'right'].includes(hand)));
    } catch (_) { return {}; }
  }

  // Keep playing the original SMF. Route only piano note events to two banks
  // of synth channels so live muting can stop held/pedalled voices in one hand.
  // On/off queues are independent to handle overlapping same-pitch notes.
  function createHandRouter(notes, handFor, isEnabled, fromTime = 0) {
    const ons = new Map(), offs = new Map();
    const insert = (map, n) => {
      const key = n.channel + ':' + n.midi;
      if (!map.has(key)) map.set(key, { index: 0, notes: [] });
      map.get(key).notes.push(n);
    };
    const ordered = notes.slice().sort((a, b) => a.start - b.start || a.track - b.track);
    for (const n of ordered) {
      if (n.start >= fromTime - 0.00001) insert(ons, n);
      if (n.end >= fromTime - 0.00001) insert(offs, n);
    }
    for (const queue of offs.values()) queue.notes.sort((a, b) => a.end - b.end || a.track - b.track);
    return (synth, type, event) => {
      const ch = event.getChannel();
      if (ch < 0 || ch > 15) return false;
      if (type === 0x90 || type === 0x80) {
        const isOn = type === 0x90 && event.getVelocity() > 0;
        const queue = (isOn ? ons : offs).get(ch + ':' + event.getKey());
        const note = queue?.notes[queue.index++];
        if (!note || !note.piano) return false;
        const hand = handFor(note);
        if (!hand) return false;
        const target = ch + (hand === 'left' ? 16 : 32);
        if (isOn) {
          if (isEnabled(hand)) synth.midiNoteOn(target, event.getKey(), event.getVelocity());
        } else synth.midiNoteOff(target, event.getKey());
        return true;
      }
      // Continue sending controls even when a hand is silent, keeping its
      // pedal, bank, program, bend, and expression ready when re-enabled.
      for (const target of [ch + 16, ch + 32]) {
        if (type === 0xb0) synth.midiControl(target, event.getControl(), event.getValue());
        else if (type === 0xc0) synth.midiProgramChange(target, event.getProgram());
        else if (type === 0xe0) synth.midiPitchBend(target, event.getPitch());
        else if (type === 0xd0) synth.midiChannelPressure(target, event.getValue());
        else if (type === 0xa0) synth.midiKeyPressure(target, event.getKey(), event.getValue());
      }
      return false;
    };
  }
  function encodeMidi(midi) {
    const output = fromJSON(midi, JSON.parse(JSON.stringify(midi.toJSON())));
    // Tone 2.0.28's parser normalizes bends, but its encoder expects the raw
    // signed 14-bit value. Scale only the throwaway serialization copy.
    output.tracks.forEach(track => track.pitchBends.forEach(bend => { bend.value = Math.round(bend.value * 8192); }));
    return output.toArray();
  }

  // FluidSynth's seekPlayer can leave the MIDI player at tick zero or silent
  // when invoked just after play. Build a short SMF that starts at the requested
  // position instead. Its controller state and held notes begin at tick zero.
  function segmentAt(midi, seconds, hands = {}) {
    const cut = Math.max(0, midi.header.secondsToTicks(seconds));
    if (!cut) return { data: midi.toArray(), notes: describeNotes(midi).map(n => ({ ...n, hand: hands[n.id] })) };
    const output = fromJSON(midi, JSON.parse(JSON.stringify(midi.toJSON())));
    const header = output.header;
    const shiftMap = (items, fallback) => {
      const ordered = items.slice().sort((a, b) => a.ticks - b.ticks);
      const current = ordered.filter(e => e.ticks <= cut).at(-1) || fallback;
      return [{ ...current, ticks: 0 }, ...ordered.filter(e => e.ticks > cut).map(e => ({ ...e, ticks: e.ticks - cut }))];
    };
    header.tempos = shiftMap(header.tempos, { ticks: 0, bpm: 120 });
    if (header.timeSignatures.length) header.timeSignatures = shiftMap(header.timeSignatures, header.timeSignatures[0]);
    header.keySignatures = header.keySignatures.filter(e => e.ticks >= cut).map(e => ({ ...e, ticks: e.ticks - cut }));
    header.update();
    const routed = [];
    midi.tracks.forEach((source, ti) => {
      const dest = output.tracks[ti];
      const pedal = (source.controlChanges[64] || []).slice().sort((a, b) => a.ticks - b.ticks);
      let sustainStart = null;
      for (const event of pedal) {
        if (event.ticks > cut) break;
        if (event.value < 0.5) sustainStart = null;
        else if (sustainStart === null) sustainStart = event.ticks;
      }
      const pedalHolds = note => sustainStart !== null
        && note.ticks + note.durationTicks >= sustainStart
        && note.ticks + note.durationTicks <= cut;
      const recentPedalNotes = new Map();
      for (const note of source.notes) {
        const age = seconds - midi.header.ticksToSeconds(note.ticks + note.durationTicks);
        if (age >= 0 && age <= 2 && pedalHolds(note)) recentPedalNotes.set(note.midi, note);
      }
      dest.notes = [];
      source.notes.forEach((note, ni) => {
        const end = note.ticks + note.durationTicks;
        const held = note.ticks < cut && recentPedalNotes.get(note.midi) === note;
        if (end <= cut && !held) return;
        const start = Math.max(note.ticks, cut);
        const duration = held ? 1 : Math.max(1, end - start);
        const age = seconds - midi.header.ticksToSeconds(end);
        const velocity = held ? Math.max(0.05, note.velocity * 0.4 * Math.exp(-age / 2)) : note.velocity;
        dest.addNote({ ticks: start - cut, durationTicks: duration,
          midi: note.midi, velocity, noteOffVelocity: note.noteOffVelocity });
        routed.push({ id: ti + ':' + ni, track: ti, channel: source.channel,
          piano: !source.instrument.percussion && source.instrument.number < 8,
          midi: note.midi, start: header.ticksToSeconds(start - cut),
          end: header.ticksToSeconds(start - cut + duration), hand: hands[ti + ':' + ni] });
      });
      for (const [number, events] of Object.entries(source.controlChanges)) {
        const ordered = events.slice().sort((a, b) => a.ticks - b.ticks);
        const current = ordered.filter(e => e.ticks <= cut).at(-1);
        dest.controlChanges[number] = [];
        if (current) dest.addCC({ number: Number(number), ticks: 0, value: current.value });
        ordered.filter(e => e.ticks > cut).forEach(e => dest.addCC({ number: Number(number), ticks: e.ticks - cut, value: e.value }));
      }
      const lastBend = source.pitchBends.filter(e => e.ticks <= cut).at(-1);
      dest.pitchBends = [];
      if (lastBend) dest.addPitchBend({ ticks: 0, value: lastBend.value });
      source.pitchBends.filter(e => e.ticks > cut).forEach(e => dest.addPitchBend({ ticks: e.ticks - cut, value: e.value }));
    });
    return { data: encodeMidi(output), notes: routed };
  }
  const api = { estimateHands, describeNotes, splitHands, namedHand, storageKey, readOverrides, createHandRouter, encodeMidi, segmentAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PianoEnhancements = api;
})(typeof window !== 'undefined' ? window : globalThis);
