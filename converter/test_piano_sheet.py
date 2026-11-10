import base64
import io
import pathlib
import tempfile
import unittest
import xml.etree.ElementTree as ET

import mido
from piano_sheet import generate


def fixture(path):
    midi = mido.MidiFile(ticks_per_beat=480)
    midi.tracks.append(mido.MidiTrack([
        mido.MetaMessage("set_tempo", tempo=500000),
        mido.MetaMessage("time_signature", numerator=4, denominator=4),
        mido.MetaMessage("key_signature", key="D"),
        mido.MetaMessage("set_tempo", tempo=750000, time=1920),
        mido.MetaMessage("time_signature", numerator=3, denominator=4),
    ]))
    # A held bass, unequal chord durations, a bar-crossing tie, then triplets.
    events = [(480, mido.Message("note_on", note=48, velocity=80)),
              (2400, mido.Message("note_off", note=48)),
              (480, mido.Message("note_on", note=66, velocity=80)),
              (960, mido.Message("note_off", note=66)),
              (480, mido.Message("note_on", note=69, velocity=80)),
              (1440, mido.Message("note_off", note=69)),
              (480, mido.Message("control_change", control=64, value=127)),
              (2500, mido.Message("control_change", control=64, value=0))]
    for start, pitch in zip((1440, 1600, 1760), (67, 69, 71)):
        events.extend([(start, mido.Message("note_on", note=pitch, velocity=90)),
                       (start + 160, mido.Message("note_off", note=pitch))])
    piano = mido.MidiTrack([mido.MetaMessage("track_name", name="Piano"), mido.Message("program_change", program=0)])
    last = 0
    for tick, message in sorted(events, key=lambda e: e[0]):
        piano.append(message.copy(time=tick-last)); last = tick
    midi.tracks.append(piano)
    midi.tracks.append(mido.MidiTrack([mido.MetaMessage("track_name", name="Strings"),
        mido.Message("program_change", channel=1, program=48),
        mido.Message("note_on", channel=1, note=72, velocity=70),
        mido.Message("note_off", channel=1, note=72, time=1920)]))
    midi.save(path)
    return midi


class PianoSheetTests(unittest.TestCase):
    def test_unequal_chord_durations_split_complex_voice_rests(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "unequal-chord.mid"
            midi = mido.MidiFile(ticks_per_beat=480)
            midi.tracks.append(mido.MidiTrack([
                mido.Message("note_on", note=72, velocity=80),
                mido.Message("note_on", note=76, velocity=80),
                mido.Message("note_off", note=72, time=360),
                mido.Message("note_off", note=76, time=1560),
            ]))
            midi.save(path)
            original = path.read_bytes()
            for rhythm in ("normal", "fine"):
                result = generate(path, rhythm=rhythm)
                xml = ET.fromstring(result["musicxml"])
                self.assertTrue(xml.findall(".//rest"))
                self.assertGreater(len(xml.findall(".//voice")), 2)
                self.assertEqual(path.read_bytes(), original)

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = pathlib.Path(self.folder.name) / "piano.mid"
        fixture(self.path)
        self.midi = mido.MidiFile(self.path)

    def test_grand_staff_voices_ties_triplets_and_metadata_preserve_source(self):
        original = self.path.read_bytes()
        result = generate(self.path)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(result["track_ids"], ["1:0"])
        xml = ET.fromstring(result["musicxml"])
        self.assertEqual({n.text for n in xml.findall(".//clef/sign")}, {"G", "F"})
        self.assertTrue(xml.findall(".//tie"))
        self.assertTrue(xml.findall(".//time-modification"))
        self.assertGreater(len({n.text for n in xml.findall(".//voice")}), 1)
        self.assertIn("2", [n.text for n in xml.findall(".//key/fifths")])
        self.assertIn("3", [n.text for n in xml.findall(".//time/beats")])
        self.assertEqual([n.attrib["tempo"] for n in xml.findall(".//sound") if "tempo" in n.attrib], ["120", "80"])
        measures = xml.findall(".//part/measure")
        self.assertEqual(len(measures), 2)
        self.assertTrue(any(n.find("rest") is not None and n.findtext("staff") == "1"
                            for n in measures[-1].findall("note")))
        playback = mido.MidiFile(file=io.BytesIO(base64.b64decode(result["midi_base64"])))
        self.assertEqual(list(playback.tracks[1]), list(self.midi.tracks[1]))
        self.assertFalse(any(m.type == "note_on" for m in playback.tracks[2]))
        self.assertTrue(xml.findall(".//rest"))

    def test_track_choice_split_and_fine_detail(self):
        result = generate(self.path, ["2:1"], split=80, rhythm="fine")
        playback = mido.MidiFile(file=io.BytesIO(base64.b64decode(result["midi_base64"])))
        self.assertTrue(any(m.type == "note_on" for m in playback.tracks[2]))
        self.assertFalse(any(m.type == "note_on" for m in playback.tracks[1]))
        self.assertIn("<staff>2</staff>", result["musicxml"])
        self.assertEqual(result["rhythm"], "fine")

    def test_defaults_named_hands_and_no_piano_fallback(self):
        midi = mido.MidiFile(ticks_per_beat=480)
        midi.tracks.append(mido.MidiTrack([mido.MetaMessage("track_name", name="Left hand"),
            mido.Message("program_change", program=48),
            mido.Message("note_on", note=76, velocity=70),
            mido.Message("note_off", note=76, time=480)]))
        midi.save(self.path)
        result = generate(self.path)
        self.assertEqual(result["track_ids"], ["0:0"])
        xml = ET.fromstring(result["musicxml"])
        pitched = xml.findall(".//note[pitch]")
        self.assertTrue(pitched)
        self.assertTrue(all(n.findtext("staff") == "2" for n in pitched))
        self.assertEqual(xml.findtext(".//time/beats"), "4")
        self.assertEqual(len(xml.findall(".//part/measure")), 1)

    def test_bad_options_empty_and_malformed_midi(self):
        for options in ({"track_ids": []}, {"track_ids": ["missing"]}, {"split": True},
                        {"split": 200}, {"rhythm": "bad"}, {"track_ids": "1:0"}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                generate(self.path, **options)
        empty = mido.MidiFile(); empty.tracks.append(mido.MidiTrack()); empty.save(self.path)
        with self.assertRaisesRegex(ValueError, "no pitched notes"):
            generate(self.path)
        self.path.write_bytes(b"invalid MIDI")
        with self.assertRaisesRegex(ValueError, "could not be read"):
            generate(self.path)


if __name__ == "__main__":
    unittest.main()
