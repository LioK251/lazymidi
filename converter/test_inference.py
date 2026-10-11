"""Small real inference/cancellation check using a built optional runtime."""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import wave

parser=argparse.ArgumentParser();parser.add_argument("--device",default="cpu");args=parser.parse_args()
root=Path(__file__).resolve().parent
with tempfile.TemporaryDirectory() as directory:
    data=Path(directory);ready=data/"ready.json"
    env={**os.environ,"PATH":str(Path(sys.executable).parent.parent/"ffmpeg")+os.pathsep+os.environ["PATH"],"LAZYMIDI_CONVERTER_DATA":directory,"LAZYMIDI_CONVERTER_TOKEN":"inference-test-token","LAZYMIDI_READY_FILE":str(ready),"OMP_NUM_THREADS":"2","MKL_NUM_THREADS":"2","OPENBLAS_NUM_THREADS":"2"}
    with (data/"service.log").open("w",encoding="utf-8") as log:
        child=subprocess.Popen([sys.executable,"-X","utf8",str(root/"service.py")],env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW if os.name=="nt" else 0)
        try:
            deadline=time.monotonic()+20
            while not ready.exists():
                if child.poll() is not None or time.monotonic()>deadline:raise RuntimeError((data/"service.log").read_text())
                time.sleep(.05)
            import requests
            url=f'http://127.0.0.1:{json.loads(ready.read_text())["port"]}'
            headers={"X-Lazymidi-Token":"inference-test-token"}
            audio=data/"piano-test.wav"
            import struct
            with wave.open(str(audio),"wb") as wav:
                wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(44100)
                wav.writeframes(b''.join(struct.pack('<h',int(6000*math.sin(2*math.pi*261.63*i/44100)*math.exp(-i/22050))) for i in range(44100)))
            start=time.monotonic()
            with audio.open("rb") as handle:
                response=requests.post(url+"/api/upload-media",headers=headers,files={"file":("piano.wav",handle)},data={"device":args.device},timeout=10)
            response.raise_for_status();job=response.json()["task_id"]
            while True:
                status=requests.get(url+"/api/status/"+job,headers=headers,timeout=10).json()
                if status["status"] in {"completed","error","cancelled"}:break
                if time.monotonic()-start>180:raise TimeoutError("Inference exceeded 180 seconds")
                time.sleep(.25)
            assert status["status"]=="completed",status
            assert (data/"converted"/status["midi_name"]).is_file()
            print(json.dumps({"device":args.device,"seconds":round(time.monotonic()-start,2),"status":status["status"]}))
            with audio.open("rb") as handle:
                job=requests.post(url+"/api/upload-media",headers=headers,files={"file":("cancel.wav",handle)},data={"device":args.device},timeout=10).json()["task_id"]
            requests.post(url+"/api/stop/"+job,headers=headers,timeout=10).raise_for_status()
            time.sleep(.5)
            assert requests.get(url+"/api/status/"+job,headers=headers,timeout=10).json()["status"]=="cancelled"
            print("Cancellation passed")
        finally:
            child.terminate();child.wait(timeout=10)
