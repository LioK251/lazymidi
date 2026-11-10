"""Piano engraving from MIDI; playback keeps the original events and timing."""
import base64
import io
import re
from collections import defaultdict, deque

import mido


def generate(path, track_ids=None, split=60, rhythm="normal"):
    if type(split) is not int or not 21 <= split <= 108:
        raise ValueError("Staff split must be a piano note from 21 to 108.")
    if rhythm not in ("normal", "fine"):
        raise ValueError("Choose normal or fine rhythm detail.")
    if track_ids is not None and (not isinstance(track_ids, list) or
                                 any(not isinstance(t, str) for t in track_ids)):
        raise ValueError("Choose valid MIDI tracks.")
    if path.stat().st_size > 8 * 1024**2:
        raise ValueError("Piano notation supports MIDI files up to 8 MiB.")
    from music21 import chord, instrument, key, layout, metadata, meter, musicxml, note, stream, tempo, clef

    try:
        midi = mido.MidiFile(path)
    except (OSError, EOFError, ValueError, KeyError) as error:
        raise ValueError("This file could not be read as MIDI.") from error
    if midi.type == 2 or midi.ticks_per_beat <= 0:
        raise ValueError("Piano notation requires a beat-based type 0 or type 1 MIDI file.")
    tracks, notes, signatures = {}, [], {}
    for index, track in enumerate(midi.tracks):
        name = next((m.name for m in track if m.type == "track_name"), "")
        name = re.sub(r"[\x00-\x1f]", "", name)[:120]
        tick, programs = 0, defaultdict(int)
        held = defaultdict(deque)
        for message in track:
            tick += message.time
            if message.type in ("set_tempo", "time_signature", "key_signature"):
                signatures[tick, message.type] = message
            if not hasattr(message, "channel") or message.channel == 9:
                continue
            identity = f"{index}:{message.channel}"
            if message.type == "program_change":
                programs[message.channel] = message.program
            elif message.type == "note_on" and message.velocity:
                tracks.setdefault(identity, {"id": identity, "name": name or f"Track {index + 1}",
                                            "piano": programs[message.channel] < 8})
                held[message.channel, message.note].append((tick, message.velocity))
            elif message.type in ("note_off", "note_on"):
                queue = held[message.channel, message.note]
                if queue:
                    start, velocity = queue.popleft()
                    if tick > start:
                        notes.append((identity, message.note, start, tick, velocity))
        if any(held.values()):
            raise ValueError("MIDI contains notes without releases. Repair or re-export the MIDI first.")
    if not notes:
        raise ValueError("This MIDI has no pitched notes to display.")
    selected = list(dict.fromkeys(track_ids)) if track_ids is not None else [t["id"] for t in tracks.values() if t["piano"]]
    if track_ids is None and not selected:
        selected = list(tracks)
    if not selected or any(t not in tracks for t in selected):
        raise ValueError("Select at least one available track.")
    notes = [n for n in notes if n[0] in selected]
    if not notes:
        raise ValueError("The selected tracks have no playable notes.")
    # shortcut: bound full-score engraving; render systems incrementally before raising these limits.
    if len(notes) > 20000 or max(n[3] for n in notes) / midi.ticks_per_beat > 8000:
        raise ValueError("This score is too large. Select fewer tracks or a shorter MIDI (up to 20,000 notes / 8,000 beats).")
    score_end = max(n[3] for n in notes) / midi.ticks_per_beat
    bars, previous, bar_length = 0, 0, 4
    for (tick, kind), message in sorted(signatures.items()):
        if kind != "time_signature" or tick / midi.ticks_per_beat > score_end:
            continue
        if not 1 <= message.numerator <= 32 or not 1 <= message.denominator <= 64:
            raise ValueError("Unsupported time signature.")
        offset = tick / midi.ticks_per_beat
        bars += (offset - previous) / bar_length + 1
        previous, bar_length = offset, message.numerator * 4 / message.denominator
    if bars + (score_end - previous) / bar_length > 2000:
        raise ValueError("This score has too many measures. Choose a shorter MIDI.")

    score = stream.Score()
    score.metadata = metadata.Metadata(title="Piano")
    staves = [stream.PartStaff(id="right"), stream.PartStaff(id="left")]
    for staff, staff_clef in zip(staves, (clef.TrebleClef(), clef.BassClef())):
        staff.insert(0, instrument.Piano())
        staff.insert(0, staff_clef)
        staff.insert(0, meter.TimeSignature("4/4"))
        if staff is staves[0]:
            staff.insert(0, tempo.MetronomeMark(number=120))
        for (tick, kind), message in sorted(signatures.items()):
            offset = tick / midi.ticks_per_beat
            if offset > score_end:
                continue
            if kind == "time_signature":
                if not 1 <= message.numerator <= 32 or not 1 <= message.denominator <= 64:
                    raise ValueError("Unsupported time signature.")
                element = meter.TimeSignature(f"{message.numerator}/{message.denominator}")
            elif kind == "key_signature":
                element = key.Key(message.key[:-1] if message.key.endswith("m") else message.key,
                                  "minor" if message.key.endswith("m") else "major")
            else:
                if staff is not staves[0]:
                    continue
                if message.tempo <= 0:
                    raise ValueError("Invalid MIDI tempo.")
                element = tempo.MetronomeMark(number=mido.tempo2bpm(message.tempo))
            if offset == 0:
                for previous in list(staff.getElementsByClass(type(element))):
                    staff.remove(previous)
            staff.insert(offset, element)
    for identity, pitch, start, end_tick, velocity in notes:
        name = tracks[identity]["name"]
        hand = 1 if re.search(r"\b(left hand|left|lh)\b", name, re.I) else 0 if re.search(r"\b(right hand|right|rh)\b", name, re.I) else int(pitch < split)
        value = note.Note(pitch, quarterLength=(end_tick - start) / midi.ticks_per_beat)
        value.volume.velocity = velocity
        staves[hand].insert(start / midi.ticks_per_beat, value)

    divisors = (8, 6) if rhythm == "fine" else (4, 3)
    for staff in staves:
        staff.quantize(divisors, processOffsets=True, processDurations=True, inPlace=True)
        groups = defaultdict(list)
        for value in list(staff.notes):
            if value.quarterLength == 0:
                value.quarterLength = 1 / max(divisors)
            groups[value.offset, value.quarterLength].append(value)
            staff.remove(value)
        for (offset, length), values in groups.items():
            pitches = sorted({n.pitch.midi for n in values})
            value = chord.Chord(pitches) if len(pitches) > 1 else note.Note(pitches[0])
            value.quarterLength = length
            staff.insert(offset, value)
    # Both hands need the same span, including conductor changes after one hand stops.
    score_end = max(staff.highestTime for staff in staves)
    for staff in staves:
        staff.makeVoices(inPlace=True, fillGaps=True)
        staff.makeRests(refStreamOrTimeRange=(0, score_end), fillGaps=True, inPlace=True)
        score.insert(0, staff)
    score.insert(0, layout.StaffGroup(staves, name="Piano", symbol="brace", barTogether=True))
    score.makeNotation(inPlace=True)
    if any(len(part.getElementsByClass(stream.Measure)) > 2000 for part in score.parts):
        raise ValueError("This score has too many measures. Choose a shorter MIDI.")
    exporter = musicxml.m21ToXml.GeneralObjectExporter(score)
    xml = exporter.parse().decode("utf-8")

    playback = mido.MidiFile(type=midi.type, ticks_per_beat=midi.ticks_per_beat)
    for index, track in enumerate(midi.tracks):
        filtered, elapsed = mido.MidiTrack(), 0
        for message in track:
            elapsed += message.time
            if not hasattr(message, "channel") or f"{index}:{message.channel}" in selected:
                filtered.append(message.copy(time=elapsed))
                elapsed = 0
        playback.tracks.append(filtered)
    output = io.BytesIO()
    playback.save(file=output)
    return {"musicxml": xml, "midi_base64": base64.b64encode(output.getvalue()).decode("ascii"),
            "tracks": list(tracks.values()), "track_ids": selected, "split": split, "rhythm": rhythm}
