"""Run with a built pack's Python: no real output devices or user data touched."""
import io
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

ORIGINAL_CWD = os.getcwd()
TEMP = tempfile.TemporaryDirectory()
os.environ["LAZYMIDI_CONVERTER_DATA"] = TEMP.name
os.environ["LAZYMIDI_CONVERTER_TOKEN"] = "test-private-token"
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import service
import pretty_midi

class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.client = service.app.test_client()
        self.headers = {"X-Lazymidi-Token": "test-private-token"}
    def test_background_upload_and_legacy_read(self):
        from PIL import Image
        image = io.BytesIO()
        Image.new("RGB", (8,8), "white").save(image, format="PNG")
        payload = image.getvalue()
        uploaded = self.client.post("/api/visualizer-background", headers=self.headers,
            data={"file":(io.BytesIO(payload),"paper.png")})
        self.assertEqual(uploaded.status_code,200)
        name = pathlib.Path(uploaded.json["url"]).name
        current = pathlib.Path(TEMP.name)/"visualizer_backgrounds"/name
        self.assertEqual(current.read_bytes(),payload)
        with self.client.get(uploaded.json["url"],headers=self.headers) as response:
            self.assertEqual(response.data,payload)
        legacy = pathlib.Path(TEMP.name)/"visualizer-backgrounds"
        legacy.mkdir(exist_ok=True)
        current.replace(legacy/name)
        with self.client.get(uploaded.json["url"],headers=self.headers) as response:
            self.assertEqual(response.data,payload)
        self.assertEqual(self.client.get("/visualizer-backgrounds/../settings.json",headers=self.headers).status_code,404)
    def test_automatic_extension_connection_rejects_websites(self):
        headers={"X-Lazymidi-Extension":"1"}
        response=self.client.get("/api/extension-connect",headers=headers)
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json["application"],"lazymidi-converter")
        token=response.json["token"]
        self.assertNotEqual(token,"test-private-token")
        self.assertEqual(self.client.get("/api/extension-health",headers={"X-Lazymidi-Token":token}).status_code,200)
        self.assertEqual(self.client.get("/api/history",headers={"X-Lazymidi-Token":token}).status_code,403)
        self.assertEqual(self.client.get("/api/extension-connect").status_code,401)
        for origin in ("https://evil.example","null"):
            self.assertEqual(self.client.get("/api/extension-connect",headers={**headers,"Origin":origin}).status_code,401)
            self.assertEqual(self.client.options("/api/extension-connect",headers={"Origin":origin,"Access-Control-Request-Headers":"X-Lazymidi-Extension"}).status_code,401)
    def test_extension_ports_skip_conflicts_and_smoke_uses_ephemeral_port(self):
        with patch.dict(os.environ,{"LAZYMIDI_EXTENSION_PORT":""}), patch("werkzeug.serving.make_server",side_effect=[SystemExit(1),object()]) as make:
            self.assertIsNotNone(service.create_server())
            self.assertEqual([call.args[:2] for call in make.call_args_list],[("127.0.0.1",27653),("127.0.0.1",27654)])
        with patch.dict(os.environ,{"LAZYMIDI_EXTENSION_PORT":"0"}), patch("werkzeug.serving.make_server") as make:
            service.create_server()
            self.assertEqual(make.call_args.args[:2],("127.0.0.1",0))
    def test_automatic_connection_over_real_loopback_http(self):
        import json
        import threading
        import urllib.request
        import urllib.error
        server=service.create_server()
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f"http://127.0.0.1:{server.server_port}"
        try:
            with urllib.request.urlopen(urllib.request.Request(base+"/api/extension-connect",headers={"X-Lazymidi-Extension":"1"}),timeout=3) as response:
                connection=json.load(response)
            self.assertEqual(connection["application"],"lazymidi-converter")
            with urllib.request.urlopen(urllib.request.Request(base+"/api/extension-health",headers={"X-Lazymidi-Token":connection["token"]}),timeout=3) as response:
                self.assertEqual(json.load(response)["status"],"ok")
            with self.assertRaises(urllib.error.HTTPError) as denied:
                urllib.request.urlopen(urllib.request.Request(base+"/api/extension-connect",headers={"X-Lazymidi-Extension":"1","Origin":"https://evil.example"}),timeout=3)
            self.assertEqual(denied.exception.code,401)
        finally:server.shutdown();server.server_close();thread.join(timeout=3)
    def test_auth_and_operation_scope(self):
        self.assertEqual(self.client.get("/api/health").status_code, 401)
        self.assertEqual(self.client.get("/api/health", headers=self.headers).status_code, 200)
        self.assertEqual(self.client.get("/api/health", headers={**self.headers,"Origin":"https://evil.example"}).status_code, 401)
        self.assertEqual(self.client.get("/", headers=self.headers).status_code, 404)
        self.assertFalse("torch" in sys.modules, "Service startup must not import PyTorch")
    def test_compute_preference_validation_and_extension_submission(self):
        original=self.client.get("/api/settings",headers=self.headers).json
        token=self.client.get("/api/extension-connect",headers={"X-Lazymidi-Extension":"1"}).json["token"]
        headers={"X-Lazymidi-Token":token}
        url="https://cdn.discordapp.com/attachments/123/456/piano.mp3?ex=123&hm=signature"
        try:
            for invalid in ("gpu",None,[],False):
                self.assertEqual(self.client.post("/api/settings",headers=self.headers,json={"compute_device":invalid}).status_code,400)
            for preference,capability,explicit,expected in (("cuda","cuda",None,"cuda"),("cuda","cpu",None,"cpu"),("cuda","cuda","cpu","cpu"),("cpu","cuda",None,"cpu")):
                self.assertEqual(self.client.post("/api/settings",headers=self.headers,json={"compute_device":preference}).status_code,200)
                self.assertEqual(self.client.get("/api/settings",headers=self.headers).json["compute_device"],preference)
                with patch.dict(os.environ,{"LAZYMIDI_COMPUTE_CAPABILITY":capability}), patch.object(service.upstream,"Thread") as thread:
                    body={"media_url":url}
                    if explicit:body["device"]=explicit
                    response=self.client.post("/api/convert",headers=headers,json=body)
                    self.assertEqual(response.status_code,202,response.json)
                    task=response.json["task_id"]
                    try:
                        self.assertEqual(thread.call_args.kwargs["args"],(task,url,expected))
                        self.assertEqual(self.client.get("/api/status/"+task,headers=headers).status_code,200)
                        self.assertEqual(self.client.get("/api/settings",headers=headers).status_code,403)
                        self.assertEqual(self.client.get("/api/status/not-owned",headers=headers).status_code,403)
                    finally:service.upstream.conversion_tasks.pop(task,None)
        finally:self.client.post("/api/settings",headers=self.headers,json=original)
    def test_runtime_switch_preserves_active_jobs_and_blocks_new_submissions(self):
        for body in ([], {}, {"prepare":"true"}):
            self.assertEqual(self.client.post("/api/runtime-switch",headers=self.headers,json=body).status_code,400)
        service._submission.acquire()
        try:
            self.assertEqual(self.client.post("/api/runtime-switch",headers=self.headers,json={"prepare":True}).status_code,409)
        finally:
            service._submission.release()
        service.upstream.conversion_tasks["switch-test"] = {"status":"queued"}
        try:
            self.assertEqual(self.client.post("/api/runtime-switch", headers=self.headers, json={"prepare":True}).status_code, 409)
            service.upstream.conversion_tasks["switch-test"]["status"] = "completed"
            self.assertEqual(self.client.post("/api/runtime-switch", headers=self.headers, json={"prepare":True}).status_code, 200)
            self.assertEqual(self.client.post("/api/convert", headers=self.headers, json={"media_url":"https://youtube.com/watch?v=test"}).status_code, 409)
        finally:
            self.client.post("/api/runtime-switch", headers=self.headers, json={"prepare":False})
            service.upstream.conversion_tasks.pop("switch-test", None)
    @unittest.skipUnless(os.environ.get("LAZYMIDI_TEST_TRANSCRIPTION"), "Explicit local CPU/CUDA transcription check")
    def test_transcription_with_selected_environment(self):
        import time
        import numpy as np
        from scipy.io import wavfile
        rate = 44100
        samples = np.zeros(int(2.6 * rate), dtype=np.float32)
        for onset, frequency in ((0.15, 261.63), (0.9, 329.63), (1.65, 392.0)):
            t = np.arange(int(0.65 * rate)) / rate
            tone = sum(gain * np.sin(2*np.pi*frequency*harmonic*t) for harmonic,gain in ((1,0.5),(2,0.2),(3,0.1)))
            tone *= np.exp(-4*t) * np.minimum(t / 0.005, 1)
            start = int(onset * rate)
            samples[start:start+len(t)] += tone.astype(np.float32)
        audio = io.BytesIO(); wavfile.write(audio,rate,samples); audio.seek(0)
        response = self.client.post("/api/upload-media", headers=self.headers,
                                    data={"file":(audio,"generated-test.wav"),"device":os.environ["LAZYMIDI_TEST_TRANSCRIPTION"]})
        self.assertIn(response.status_code,(200,202),response.json)
        task = response.json["task_id"]
        deadline = time.monotonic() + 120
        try:
            while time.monotonic() < deadline:
                result = self.client.get("/api/status/"+task,headers=self.headers).json
                if result["status"] in service.FINAL: break
                time.sleep(0.1)
            self.assertEqual(result["status"],"completed",result)
            output = service.DATA / "converted" / result["midi_name"]
            self.assertEqual(output.read_bytes()[:4],b"MThd")
            self.assertTrue(pretty_midi.PrettyMIDI(str(output)).instruments)
        finally:
            self.client.post("/api/stop/"+task,headers=self.headers)
            cleanup_deadline = time.monotonic() + 10
            while task in service._active and time.monotonic() < cleanup_deadline:
                time.sleep(0.05)
            self.assertNotIn(task,service._active)
    def test_midi_import_sheets_and_traversal(self):
        midi = pretty_midi.PrettyMIDI()
        piano = pretty_midi.Instrument(0)
        piano.notes.append(pretty_midi.Note(80, 60, 0, 1))
        midi.instruments.append(piano)
        buffer = io.BytesIO(); midi.write(buffer); buffer.seek(0)
        response=self.client.post("/api/upload-midi", headers=self.headers, data={"file":(buffer,"test.mid")})
        self.assertEqual(response.status_code,200)
        filename=response.json["midi_filename"]
        response=self.client.post("/api/convert-to-sheets",headers=self.headers,json={"midi_filename":filename,"settings":{"transpose_mode":"none"}})
        self.assertEqual(response.status_code,200)
        self.assertIn("sheet_text",response.json)
        saved=(service.DATA/"converted"/response.json["sheets_filename"]).read_bytes()
        response=self.client.post("/api/convert-to-sheets",headers=self.headers,json={"midi_filename":filename,"preview":True,"settings":{"transpose_mode":"manual","manual_transpose_points":[{"chord":0,"value":-3}]}})
        self.assertIn("Transpose by: 3",response.json["sheet_text"])
        self.assertEqual((service.DATA/"converted"/response.json["sheets_filename"]).read_bytes(),saved)
        self.assertEqual(self.client.get("/api/sheet-content?filename=../../settings.json",headers=self.headers).status_code,400)
    def test_one_job_and_automatic_extension_scope(self):
        service.upstream.conversion_tasks["test"]={"status":"queued"}
        response=self.client.post("/api/convert",headers=self.headers,json={"media_url":"https://youtube.com/watch?v=test"})
        self.assertEqual(response.status_code,409)
        del service.upstream.conversion_tasks["test"]
        origin={"Origin":"chrome-extension://test"}
        response=self.client.get("/api/extension-connect",headers={**origin,"X-Lazymidi-Extension":"1"})
        self.assertEqual(response.headers["Access-Control-Allow-Origin"],origin["Origin"])
        token=response.json["token"]
        self.assertEqual(self.client.get("/api/history",headers={**origin,"X-Lazymidi-Token":token}).status_code,403)
    def test_sheet_modes_tempo_and_timing_controls_preserve_midi(self):
        import mido
        midi=mido.MidiFile(ticks_per_beat=480);track=mido.MidiTrack();midi.tracks.append(track)
        track.append(mido.MetaMessage("set_tempo",tempo=mido.bpm2tempo(120)))
        for i,pitch in enumerate((61,65,68,73)):
            if i==2:track.append(mido.MetaMessage("set_tempo",tempo=mido.bpm2tempo(180),time=240))
            track.append(mido.Message("note_on",note=pitch,velocity=80,time=0 if i in (0,2) else 240))
            track.append(mido.Message("note_off",note=pitch,time=240))
        buffer=io.BytesIO();midi.save(file=buffer);original=buffer.getvalue();buffer.seek(0)
        response=self.client.post("/api/upload-midi",headers=self.headers,data={"file":(buffer,"tempo-modes.mid")})
        filename=response.json["midi_filename"]
        def sheet(settings):
            response=self.client.post("/api/convert-to-sheets",headers=self.headers,json={"midi_filename":filename,"settings":settings})
            self.assertEqual(response.status_code,200,response.json)
            return response.json["sheet_text"]
        text=sheet({"transpose_mode":"none"})
        self.assertIn("Tempo: 120 BPM",text);self.assertIn("BPM changed to 180",text);self.assertIn(", ",text)
        no_bpm=sheet({"transpose_mode":"none","show_bpm_changes_as_comments":False})
        self.assertNotIn("<!--",no_bpm);self.assertIn(", ",no_bpm)
        no_timing=sheet({"transpose_mode":"none","show_tempo_timing_marks":False})
        self.assertIn("Tempo: 120 BPM",no_timing);self.assertNotIn(", ",no_timing)
        neither=sheet({"transpose_mode":"none","show_tempo_timing_marks":False,"show_bpm_changes_as_comments":False})
        self.assertNotIn("<!--",neither);self.assertNotIn(", ",neither)
        for mode in ("auto","multi"):
            self.assertNotEqual(sheet({"transpose_mode":mode,"resilience":0}),text)
        manual=sheet({"transpose_mode":"manual","manual_transpose_points":[{"chord":0,"value":-3},{"chord":2,"value":2}]})
        self.assertIn("Transpose by: 3",manual);self.assertIn("Transpose by: -2",manual)
        self.assertEqual(sheet({"auto_transpose":False}),text)
        self.assertEqual(sheet({"multi_transpose":True,"resilience":0}),sheet({"transpose_mode":"multi","resilience":0}))
        self.assertEqual((service.DATA/"converted"/filename).read_bytes(),original)
    def test_sheet_preferences_round_trip_and_reject_invalid_flags(self):
        saved={"transpose_mode":"manual","manual_transpose_points":[{"chord":0,"value":-3}],"show_bpm_changes_as_comments":False,"show_tempo_timing_marks":True,"quantize":50,"break_lines_how":"manually","break_lines_every":8}
        self.assertEqual(self.client.post("/api/settings",headers=self.headers,json=saved).status_code,200)
        self.assertEqual(self.client.get("/api/settings",headers=self.headers).json,saved)
        saved["always_open_float"]=True
        self.assertEqual(self.client.post("/api/settings",headers=self.headers,json=saved).status_code,200)
        self.assertEqual(self.client.get("/api/settings",headers=self.headers).json,saved)
        for key in ("show_bpm_changes_as_comments","show_tempo_timing_marks","always_open_float"):
            self.assertEqual(self.client.post("/api/settings",headers=self.headers,json={key:"false"}).status_code,400)
            self.assertEqual(self.client.get("/api/settings",headers=self.headers).json,saved)
        self.assertEqual(self.client.post("/api/settings",headers=self.headers,json={"always_open_float":0}).status_code,400)
        saved["always_open_float"]=False
        self.assertEqual(self.client.post("/api/settings",headers=self.headers,json=saved).status_code,200)
        self.assertEqual(self.client.get("/api/settings",headers=self.headers).json,saved)
    def test_manual_headers_split_at_exact_chords_and_report_line_starts(self):
        midi=pretty_midi.PrettyMIDI(initial_tempo=120);piano=pretty_midi.Instrument(0)
        for i in range(6):piano.notes.append(pretty_midi.Note(80,60+i,i*.25,i*.25+.1))
        midi.instruments.append(piano);buffer=io.BytesIO();midi.write(buffer);buffer.seek(0)
        filename=self.client.post("/api/upload-midi",headers=self.headers,data={"file":(buffer,"manual-boundary.mid")}).json["midi_filename"]
        response=self.client.post("/api/convert-to-sheets",headers=self.headers,json={"midi_filename":filename,"settings":{"transpose_mode":"manual","manual_transpose_points":[{"chord":0,"value":-3},{"chord":2,"value":2}],"break_lines_every":100,"show_bpm_changes_as_comments":False}})
        self.assertEqual(response.status_code,200,response.json)
        lines=response.json["sheet_text"].splitlines();mapping=response.json["line_chord_map"]
        first=lines.index("Transpose by: 3");second=next(i for i,line in enumerate(lines) if line.startswith("Transpose by: -2"))
        self.assertEqual(mapping[first],0);self.assertEqual(mapping[first+1],0)
        self.assertEqual(mapping[second],2);self.assertEqual(mapping[second+1],2)
    def test_sf2_import_validation_and_scoped_listing(self):
        response=self.client.post("/api/upload-soundfont",headers=self.headers,data={"file":(io.BytesIO(b"invalid"),"broken.sf2")})
        self.assertEqual(response.status_code,400)
        response=self.client.post("/api/upload-soundfont",headers=self.headers,data={"file":(io.BytesIO(b"RIFF\x04\x00\x00\x00sfbk"),"header-test.sf2")})
        self.assertEqual(response.status_code,200)
        filename=response.json["filename"]
        self.assertTrue(any(font["filename"]==filename for font in self.client.get("/api/soundfonts",headers=self.headers).json["soundfonts"]))
    def test_copy_import_never_overwrites_or_copies_cookies(self):
        source=pathlib.Path(TEMP.name)/"original";source.mkdir(exist_ok=True)
        (source/"converted").mkdir(exist_ok=True);(source/"converted/test.mid").write_bytes(b"original")
        (source/"converted/art.jpg").write_bytes(b"artwork")
        (source/"history.json").write_text('[{"midi_name":"test.mid","thumbnail_url":"/converted/art.jpg"}]')
        (source/"cookies.txt").write_text("private")
        dest=pathlib.Path(TEMP.name)/"new";dest.mkdir(exist_ok=True)
        (dest/"converted").mkdir(exist_ok=True);(dest/"converted/test.mid").write_bytes(b"existing")
        (dest/"converted/art.jpg").write_bytes(b"existing art")
        service.copy_import(source,dest)
        self.assertEqual((source/"converted/test.mid").read_bytes(),b"original")
        self.assertEqual((dest/"converted/test.mid").read_bytes(),b"existing")
        self.assertFalse((dest/"cookies.txt").exists())
        self.assertEqual(len(list((dest/"converted").glob("*.mid"))),2)
        import json
        imported=json.loads((dest/"history.json").read_text())[-1]
        self.assertNotEqual(imported["thumbnail_url"],"/converted/art.jpg")
        self.assertEqual((dest/imported["thumbnail_url"].lstrip("/")).read_bytes(),b"artwork")
        self.assertEqual((source/"converted/art.jpg").read_bytes(),b"artwork")
    def test_import_folder_preserves_history_order_and_is_repeatable(self):
        import json
        with tempfile.TemporaryDirectory() as folder:
            source=pathlib.Path(folder)/"old";dest=pathlib.Path(folder)/"new"
            (source/"converted").mkdir(parents=True);(dest/"converted").mkdir(parents=True)
            (source/"converted/test.mid").write_bytes(b"imported midi")
            (source/"converted/test_sheets.txt").write_text("[etu] - :1")
            (dest/"converted/test.mid").write_bytes(b"existing midi")
            (dest/"history.json").write_text('[{"midi_name":"existing.mid","timestamp":1,"type":"midi"}]')
            history=[{"midi_name":"test.mid","timestamp":2,"type":"youtube","video_title":"Old song"}]
            (source/"history.json").write_text(json.dumps(history),encoding="utf-8-sig")
            (source/"visualizer_backgrounds").mkdir();(source/"visualizer_backgrounds/bg.png").write_bytes(b"image")
            (source/"settings.json").write_text('{"visualizer_scenes":{"classic":{"media_url":"/visualizer-backgrounds/bg.png"}},"cookie_path":"secret"}')
            result=service.copy_import(source/"converted",dest)
            self.assertEqual((result["midis"],result["history"],result["copied"]),(1,1,3))
            saved=json.loads((dest/"history.json").read_text())
            self.assertEqual([h["timestamp"] for h in saved],[1,2])
            self.assertNotEqual(saved[1]["midi_name"],"test.mid")
            self.assertEqual((dest/"converted"/saved[1]["midi_name"]).read_bytes(),b"imported midi")
            self.assertEqual((dest/"converted/test.mid").read_bytes(),b"existing midi")
            settings=json.loads((dest/"settings.json").read_text())
            self.assertNotIn("cookie_path",settings)
            self.assertEqual(settings["visualizer_scenes"]["classic"]["media_url"],"/visualizer-backgrounds/bg.png")
            self.assertEqual(service.copy_import(source,dest),{"copied":0,"midis":0,"history":0,"skipped":3})
            self.assertEqual(json.loads((dest/"history.json").read_text()),saved)
            self.assertEqual(json.loads((source/"history.json").read_text(encoding="utf-8-sig")),history)
    def test_import_plain_midi_folder_and_reject_malformed_history_before_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            source=pathlib.Path(folder)/"midi";dest=pathlib.Path(folder)/"new"
            source.mkdir();dest.mkdir()
            (source/"solo.midi").write_bytes(b"midi")
            (source/"cookies.txt").write_text("private")
            result=service.copy_import(source,dest)
            self.assertEqual(result["midis"],1)
            self.assertFalse((dest/"cookies.txt").exists())
            for invalid in ('{bad}', '[{}', '[{"timestamp":[]}]', '[{"video_title":{}}]'):
                (source/"history.json").write_text(invalid)
                with self.assertRaises(ValueError):service.copy_import(source,pathlib.Path(folder)/"invalid")
                self.assertFalse((pathlib.Path(folder)/"invalid").exists())
            with self.assertRaises(ValueError):service.copy_import(source,source/"nested")
            for body in ([],{}, {"source":[]}):
                self.assertEqual(self.client.post("/api/import-data",headers=self.headers,json=body).status_code,400)
    def test_settings_validation_backup_and_recovery(self):
        from persistence import atomic_json, read_json
        path=pathlib.Path(TEMP.name)/"settings.json"
        atomic_json(path,{"quantize":35});atomic_json(path,{"quantize":40})
        self.assertEqual(self.client.post("/api/settings",headers=self.headers,json={"quantize":-1}).status_code,400)
        self.assertEqual(read_json(path,{})["quantize"],40)
        path.write_text("invalid",encoding="utf-8")
        self.assertEqual(self.client.get("/api/settings",headers=self.headers).json["quantize"],35)
        self.assertTrue(list(path.parent.glob("settings.json.invalid-*")))
        self.assertEqual(self.client.post("/api/settings",headers=self.headers,json={"manual_transpose_points":[{"chord":0,"value":51}]}).status_code,400)
        self.assertEqual(self.client.post("/api/settings",headers=self.headers,json={"always_open_float":"true"}).status_code,400)
        saved={"visualizer_scenes":{"sketch":{"keyboard":"sketch","mode":"image","media_url":"/visualizer-backgrounds/"+"a"*32+".png"}}}
        self.assertEqual(self.client.post("/api/settings",headers=self.headers,json={**saved,"visualizer_hands":True}).status_code,200)
        self.assertEqual(self.client.get("/api/settings",headers=self.headers).json,saved)
        self.assertEqual(read_json(path,{}),saved)
        atomic_json(path,{**saved,"visualizer_hands":"legacy"})
        self.assertEqual(self.client.get("/api/settings",headers=self.headers).json,saved)
    def test_download_names_preserve_files_and_brand_legacy_outputs(self):
        for name, expected in (("Song_transkun.mid","Song_lazymidi.mid"),("Song_transkun_2_sheets.txt","Song_lazymidi_2_sheets.txt"),("Song_transkun_remix.mid","Song_transkun_remix.mid")):
            path=service.DATA/"converted"/name
            path.write_bytes(b"original content")
            response=self.client.get("/converted/"+name,headers=self.headers)
            self.assertEqual(response.status_code,200)
            self.assertIn(expected,response.headers["Content-Disposition"])
            self.assertEqual(response.data,b"original content")
            response.close()
            self.assertEqual(path.read_bytes(),b"original content")
    def test_cancelled_worker_still_blocks_next_job_until_cleanup(self):
        service._active.add("cancelled-worker")
        try:
            response=self.client.post("/api/convert",headers=self.headers,json={"media_url":"https://youtube.com/watch?v=test"})
            self.assertEqual(response.status_code,409)
        finally: service._active.clear()
    def test_cancellation_survives_worker_progress_updates(self):
        task="cancel-race"
        service.upstream.conversion_tasks[task]={"status":"queued"}
        self.assertEqual(self.client.post("/api/stop/"+task,headers=self.headers).status_code,200)
        service.upstream.conversion_tasks[task]={"status":"processing"}
        self.assertTrue(service.upstream._is_cancelled(task))
        @service.tracked_job
        def late_worker(task): service.upstream.conversion_tasks[task]={"status":"completed"}
        late_worker(task)
        self.assertEqual(service.upstream.conversion_tasks[task]["status"],"cancelled")

def tearDownModule():
    import logging
    logging.shutdown()
    os.chdir(ORIGINAL_CWD)
    TEMP.cleanup()

if __name__ == "__main__":
    unittest.main()
