"""Piano engraving from MIDI; playback keeps the original events and timing."""
import base64
import io
import math
import re
from collections import defaultdict, deque
from fractions import Fraction
from statistics import median

import mido


def _performance_grid(notes, signatures, ppq, subdivision):
    # Transcribed MIDI often has a placeholder 120 BPM clock, not musical beats.
    if any(kind == "key_signature" or kind == "set_tempo" and message.tempo != 500000 or
           kind == "time_signature" and tick != 0 for (tick, kind), message in signatures.items()):
        return notes, signatures, {}
    onsets, indices = [], {}
    for start in sorted({n[2] for n in notes}):
        if not onsets or start - onsets[-1] > ppq * .08:
            onsets.append(start)
        indices[start] = len(onsets) - 1
    if len(onsets) < 16:
        return notes, signatures, {}
    gaps = [b - a for a, b in zip(onsets, onsets[1:])]
    candidates = []
    for gap in gaps:
        if not ppq * .16 <= gap <= ppq * 3:
            continue
        while gap < ppq * .75:
            gap *= 2
        while gap >= ppq * 1.5:
            gap /= 2
        candidates.append(gap)
    if not candidates:
        return notes, signatures, {}
    quarter = median(candidates)
    error = lambda value: abs(value - round(value))
    aligned = [gap for gap in gaps if error(gap / quarter * 4) < .2]
    if aligned:
        quarter = sum(aligned) / sum(round(gap / quarter * 4) / 4 for gap in aligned)
    original = min(median(error((start - onsets[0]) / ppq * divisor) for start in onsets)
                   for divisor in (8, 6))
    fitted = [error(gap / quarter * 4) for gap in gaps]
    if (original < .15 or median(fitted) > .08 or
        median(fitted) >= median(error(gap / ppq * 4) for gap in gaps) * .65 or
        sum(value < .2 for value in fitted) < len(fitted) * .85):
        return notes, signatures, {}
    beats = [Fraction(0)]
    for gap in gaps:
        beats.append(beats[-1] + Fraction(max(1, round(gap / quarter * subdivision)), subdivision))
    adjusted = [(identity, pitch, beats[indices[start]] * ppq,
                 (beats[indices[start]] + (end - start) / quarter) * ppq, velocity)
                for identity, pitch, start, end, velocity in notes]
    bpm = 120 * ppq / quarter
    timing = [{"beat": float(beat), "time": tick / ppq * .5} for beat, tick in zip(beats, onsets)]
    adjusted_signatures = {position: message for position, message in signatures.items()
                           if position[1] != "set_tempo"}
    adjusted_signatures[0, "set_tempo"] = mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(bpm))
    return adjusted, adjusted_signatures, {"estimated_tempo": round(bpm, 1), "timing": timing}


def _split_mixed_durations(voice, origin):
    # A span between straight and triplet beats needs ties, not a 12/24/48-tuplet.
    for value in list(voice.notesAndRests):
        if not any(t.numberNotesActual > 3 for t in value.duration.tuplets):
            continue
        offset = Fraction(value.offset)
        voice.remove(value)
        pending = deque([value])
        while pending:
            piece = pending.popleft()
            if any(t.numberNotesActual > 3 for t in piece.duration.tuplets):
                start = Fraction(origin) + offset
                length = math.floor(start) + 1 - start
                if length >= piece.quarterLength:
                    length = Fraction(2) ** (math.ceil(math.log2(piece.quarterLength)) - 1)
                first, second = piece.splitAtQuarterLength(length)
                pending.extendleft((second, first))
            else:
                voice.insert(offset, piece)
                offset += Fraction(piece.quarterLength)


def _align_chords(staff):
    # Small attack/release differences in a played chord should not create extra voices.
    groups = []
    for value in staff.notes:
        previous = groups[-1] if groups else []
        if (not previous or value.offset - previous[0].offset > .08 or
                any(n.pitch == value.pitch for n in previous) or
                min(n.offset + n.quarterLength for n in previous) - value.offset <
                min(n.quarterLength for n in [*previous, value]) * .5):
            groups.append([value])
        else:
            previous.append(value)
    for values in groups:
        if len(values) < 2:
            continue
        start = median(value.offset for value in values)
        releases = []
        for value in sorted(values, key=lambda n: n.offset + n.quarterLength):
            end = value.offset + value.quarterLength
            if not releases or end - releases[-1][0][1] > .08:
                releases.append([])
            releases[-1].append((value, end))
        for release in releases:
            end = median(end for _, end in release)
            for value, _ in release:
                staff.setElementOffset(value, start)
                value.quarterLength = end - start
    return groups


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
    from music21 import articulations, chord, duration, instrument, key, layout, metadata, meter, musicxml, note, stream, tempo, clef

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
    original_end = max(n[3] for n in notes) / midi.ticks_per_beat
    score_end = original_end
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

    subdivision = 8 if rhythm == "fine" else 4
    hands = {}
    for identity in selected:
        name = tracks[identity]["name"]
        if re.search(r"\b(left hand|left|lh)\b", name, re.I):
            hands[identity] = 1
        elif re.search(r"\b(right hand|right|rh)\b", name, re.I):
            hands[identity] = 0
    if not hands and split == 60 and len(selected) == 2 and all(tracks[t]["piano"] for t in selected):
        registers = {identity: median(n[1] for n in notes if n[0] == identity) for identity in {n[0] for n in notes}}
        if len(registers) == 2:
            lower, upper = sorted(registers, key=registers.get)
            if registers[upper] - registers[lower] >= 12:
                hands = {lower: 1, upper: 0}
    notes, signatures, performance = _performance_grid(notes, signatures, midi.ticks_per_beat, subdivision)
    score_end = max(n[3] for n in notes) / midi.ticks_per_beat
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
                element = tempo.MetronomeMark(number=round(mido.tempo2bpm(message.tempo), 1))
            if offset == 0:
                for previous in list(staff.getElementsByClass(type(element))):
                    staff.remove(previous)
            staff.insert(offset, element)
    for identity, pitch, start, end_tick, velocity in notes:
        hand = hands.get(identity, int(pitch < split))
        value = note.Note(pitch, quarterLength=(end_tick - start) / midi.ticks_per_beat)
        value.volume.velocity = velocity
        staves[hand].insert(start / midi.ticks_per_beat, value)

    attacks_by_staff = [_align_chords(staff) for staff in staves]
    if not hands and split == 60 and len(selected) == 1 and tracks[selected[0]]["piano"]:
        bass, index, held_until = list(staves[1].notes), 0, 0
        for values in attacks_by_staff[0]:
            start = values[0].offset
            while index < len(bass) and bass[index].offset <= start:
                held_until = max(held_until, bass[index].offset + bass[index].quarterLength)
                index += 1
            ordered = sorted(values, key=lambda n: n.pitch.midi)
            if len(ordered) < 2 or held_until > start + .08 or ordered[0].pitch.midi > 64:
                continue
            boundary = max(range(1, min(3, len(ordered))), key=lambda i: ordered[i].pitch.midi - ordered[i-1].pitch.midi)
            if ordered[boundary].pitch.midi - ordered[boundary-1].pitch.midi < 4 or ordered[boundary-1].pitch.midi > 67:
                continue
            # A mixed track's accompaniment can rise above middle C while the bass is silent.
            for value in ordered[:boundary]:
                offset = value.offset
                staves[0].remove(value)
                staves[1].insert(offset, value)
    for staff in staves:
        beat_offsets = defaultdict(set)
        for value in staff.notes:
            beat_offsets[math.floor(value.offset)].add(float(value.offset % 1))
        divisors = {}
        triplets = 6 if rhythm == "fine" else 3
        for beat, offsets in beat_offsets.items():
            straight_error = sum(abs(x - round(x * subdivision) / subdivision) for x in offsets)
            triplet_error = sum(abs(x - round(x * triplets) / triplets) for x in offsets)
            offbeats = {round(x * triplets) for x in offsets if 0 < round(x * triplets) < triplets
                        and abs(x - round(x * triplets) / triplets) < .06
                        and abs(x - round(x * subdivision) / subdivision) > .025}
            divisors[beat] = triplets if len(offbeats) >= 2 and triplet_error < straight_error * .55 else subdivision
        attacks = defaultdict(list)
        for value in list(staff.notes):
            divisor = divisors[math.floor(value.offset)]
            offset = Fraction(round(value.offset * divisor), divisor)
            attacks[offset].append((value, divisor, value.offset + value.quarterLength))
            staff.remove(value)
        groups = defaultdict(list)
        offsets = sorted(attacks)
        for index, offset in enumerate(offsets):
            gap = offsets[index + 1] - offset if index + 1 < len(offsets) else None
            for value, divisor, end in attacks[offset]:
                played = value.quarterLength
                length = max(Fraction(1, divisor), Fraction(round(end * divisor), divisor) - offset)
                short = False
                if performance and gap is not None and gap <= 1 and end - offset <= gap + .12:
                    length = gap
                    short = played < gap * .5
                groups[offset, length].append((value, short))
        for (offset, length), values in groups.items():
            pitches = sorted({n.pitch.midi for n, _ in values})
            value = chord.Chord(pitches) if len(pitches) > 1 else note.Note(pitches[0])
            value.quarterLength = length
            for pitch in value.pitches:
                if pitch.accidental and pitch.accidental.alter == 0:
                    pitch.accidental = None
            if all(short for _, short in values):
                value.articulations.append(articulations.Staccato())
            staff.insert(offset, value)
        score.insert(0, staff)
    if len(notes) >= 12 and len({pitch % 12 for _, pitch, *_ in notes}) >= 3 and not any(kind == "key_signature" for _, kind in signatures):
        estimated_key = score.analyze("key")
        for staff in staves:
            staff.insert(0, key.KeySignature(estimated_key.sharps))
    for staff in staves:
        for value in staff.notes:
            signature = staff.getElementAtOrBefore(value.offset, [key.KeySignature])
            for pitch in value.pitches:
                if signature and pitch.accidental and pitch.accidental.alter * signature.sharps < 0:
                    pitch.getEnharmonic(inPlace=True)
        values = list(staff.notes)
        for previous, value, following in zip(values, values[1:], values[2:]):
            if (not all(n.isNote and n.quarterLength <= .5 for n in (previous, value, following)) or
                    not math.isclose(previous.offset + previous.quarterLength, value.offset) or
                    not math.isclose(value.offset + value.quarterLength, following.offset)):
                continue
            target = following.pitch
            direction = value.pitch.midi - target.midi
            if previous.pitch != target or direction != -1 or value.pitch.step != target.step:
                continue
            signature = staff.getElementAtOrBefore(previous.offset, [key.KeySignature])
            if signature is None or signature is not staff.getElementAtOrBefore(following.offset, [key.KeySignature]):
                continue
            accidental = signature.accidentalByStep(target.step)
            if (target.accidental.alter if target.accidental else 0) != (accidental.alter if accidental else 0):
                continue
            # A short lower neighbour returns by a written step, such as F-double-sharp to G-sharp.
            for spelling in value.pitch.getAllCommonEnharmonics(alterLimit=2):
                if spelling.diatonicNoteNum == target.diatonicNoteNum + direction:
                    value.pitch = spelling
                    break
    # Both hands need the same span, including conductor changes after one hand stops.
    score_end = max(staff.highestTime for staff in staves)
    if performance and score_end > performance["timing"][-1]["beat"]:
        performance["timing"].append({"beat": float(score_end), "time": original_end * .5})
    voice_offset = 0
    for staff in staves:
        staff.makeMeasures(refStreamOrTimeRange=(0, score_end), inPlace=True)
        staff.makeTies(inPlace=True)
        voice_count = 1
        for measure in staff.getElementsByClass(stream.Measure):
            measure.makeVoices(inPlace=True, fillGaps=True)
            if not measure.voices:
                voice = stream.Voice()
                for value in list(measure.notesAndRests):
                    offset = value.offset
                    measure.remove(value)
                    voice.insert(offset, value)
                measure.insert(0, voice)
            measure.makeRests(timeRangeFromBarDuration=True, fillGaps=True, inPlace=True)
            voice_count = max(voice_count, len(measure.voices))
            sounding = [(n.offset, n.offset + n.quarterLength) for voice in measure.voices for n in voice.notes]
            for index, voice in enumerate(measure.voices):
                voice.id = voice_offset + index + 1
                _split_mixed_durations(voice, measure.offset)
                # Padding keeps voices aligned but should not cover sounding notes with rests.
                for rest in voice.getElementsByClass(note.Rest):
                    if index > 0 or any(start <= rest.offset and end >= rest.offset + rest.quarterLength for start, end in sounding):
                        rest.style.hideObjectOnPrint = True
        voice_offset += voice_count
        staff.makeAccidentals(inPlace=True)
    score.insert(0, layout.StaffGroup(staves, name="Piano", symbol="brace", barTogether=True))
    score.makeNotation(inPlace=True)
    score.splitAtDurations(recurse=True)
    for staff in score.parts:
        for measure in staff.getElementsByClass(stream.Measure):
            for voice in measure.voices or [measure]:
                _split_mixed_durations(voice, measure.offset)
            signature = measure.timeSignature or measure.getContextByClass(meter.TimeSignature)
            if signature and signature.denominator == 4 and signature.numerator in (2, 3, 4):
                signature.beamSequence.partition([1] * signature.numerator)
            measure.makeBeams(inPlace=True)
            for voice in measure.voices or [measure]:
                stream.makeNotation.makeTupletBrackets(voice, inPlace=True)
                for group in duration.TupletFixer(voice).findTupletGroups(incorporateGroupings=True):
                    if (len(group) < 2 or any(n.isRest or not n.beams for n in group) or
                            [n.beams.getTypeByNumber(1) for n in group] !=
                            ['start', *(['continue'] * (len(group) - 2)), 'stop']):
                        continue
                    for value in group:
                        for tuplet in value.duration.tuplets:
                            tuplet.bracket = False
                            tuplet.placement = 'below' if group[0].stemDirection == 'down' else 'above'
    if any(len(part.getElementsByClass(stream.Measure)) > 2000 for part in score.parts):
        raise ValueError("This score has too many measures. Choose a shorter MIDI.")
    exporter = musicxml.m21ToXml.GeneralObjectExporter(score)
    # Export the finished ties without recombining mixed rhythms into large tuplets.
    exporter.makeNotation = False
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
            "tracks": list(tracks.values()), "track_ids": selected, "split": split, "rhythm": rhythm, **performance}
