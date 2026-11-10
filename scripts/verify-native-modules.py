"""Exercise the packaged frontend, floating windows, Converter and Piano in isolated storage."""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURES = r'''
import io, os, pathlib, shutil, sys
sys.path.insert(0, sys.argv[1])
data = pathlib.Path(sys.argv[2])
os.environ['LAZYMIDI_CONVERTER_DATA'] = str(data)
os.environ['LAZYMIDI_CONVERTER_TOKEN'] = 'isolated-native-test'
import service
import mido
from PIL import Image
converted = data / 'converted'
converted.mkdir(exist_ok=True)
if sys.argv[3]:
    shutil.copyfile(sys.argv[3], converted / 'smoke.mid')
else:
    midi = mido.MidiFile(ticks_per_beat=480)
    midi.tracks.append(mido.MidiTrack([
        mido.Message('note_on', note=72, velocity=80),
        mido.Message('note_on', note=76, velocity=80),
        mido.Message('note_off', note=72, time=360),
        mido.Message('note_off', note=76, time=1560),
    ]))
    midi.save(converted / 'smoke.mid')
image = io.BytesIO()
Image.new('RGB', (8, 8), '#d8d4c4').save(image, format='PNG')
client = service.app.test_client()
headers = {'X-Lazymidi-Token': 'isolated-native-test'}
uploaded = client.post('/api/visualizer-background', headers=headers,
                       data={'file': (io.BytesIO(image.getvalue()), 'smoke.png')})
assert uploaded.status_code == 200, uploaded.data
saved = client.post('/api/settings', headers=headers, json={
    'visualizer_style': 'sketch', 'visualizer_soundfont': 'builtin',
    'visualizer_scenes': {'sketch': {'keyboard': 'sketch', 'mode': 'image',
                                   'media_type': 'image', 'media_url': uploaded.json['url']}}})
assert saved.status_code == 200, saved.data
(data / 'soundfonts').mkdir(exist_ok=True)
with (data / 'soundfonts/smoke-large.sf2').open('wb') as font:
    font.truncate(65 * 1024 * 1024)
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('executable', type=pathlib.Path)
    parser.add_argument('--environment', type=pathlib.Path)
    parser.add_argument('--midi', type=pathlib.Path)
    args = parser.parse_args()
    executable = args.executable.resolve(strict=True)
    original = hashlib.sha256(args.midi.read_bytes()).digest() if args.midi else None
    with tempfile.TemporaryDirectory(prefix='lazymidi-native-check-') as directory:
        receipt = pathlib.Path(directory) / 'startup.json'
        command = [str(executable), '--smoke-test', str(receipt), '--overlays']
        if args.environment:
            environment = json.loads(args.environment.read_text(encoding='utf-8-sig'))
            python = pathlib.Path(environment['python'])
            assert python.is_absolute() and python.is_file(), 'Runtime Python is missing'
            data = receipt.with_suffix('.converter')
            data.mkdir()
            (data / 'active.json').write_text(json.dumps(environment), encoding='utf-8')
            subprocess.run([str(python), '-I', '-B', '-', str(ROOT / 'converter'),
                            str(data / 'data'), str(args.midi.resolve()) if args.midi else ''],
                           input=FIXTURES, text=True, check=True, timeout=60,
                           creationflags=0x08000000 if os.name == 'nt' else 0)
            command.append('--converter')
        subprocess.run(command, check=True, timeout=120,
                       creationflags=0x08000000 if os.name == 'nt' else 0)
        result = json.loads(receipt.read_text(encoding='utf-8'))
        assert result['native_frontend_ready'] and len(result['overlays']) == 2, result
        if args.environment:
            assert result['converter'], result
        snapshot = result['snapshot']
        assert not snapshot['analog_enabled'] and not snapshot['qwerty_enabled'], snapshot
        assert snapshot['sdk_version'] is None, snapshot
    if args.midi:
        assert hashlib.sha256(args.midi.read_bytes()).digest() == original, 'Source MIDI changed'
    print('Verified packaged frontend, floating windows and requested Converter/Piano checks; musical output stayed off.')


if __name__ == '__main__':
    main()
