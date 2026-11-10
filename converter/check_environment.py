"""Read-only compatibility check, run by the selected Python interpreter."""
import importlib
import json
import pathlib
import shutil
import struct
import subprocess
import sys
import tempfile


def check_model(device):
    import numpy as np
    import pretty_midi
    from scipy.io import wavfile
    with tempfile.TemporaryDirectory(prefix="lazymidi-runtime-check-") as directory:
        audio = pathlib.Path(directory) / "check.wav"
        midi = pathlib.Path(directory) / "check.mid"
        rate = 44100
        samples = np.zeros(int(2.6 * rate), dtype=np.float32)
        for onset, frequency in ((0.15, 261.63), (0.9, 329.63), (1.65, 392.0)):
            t = np.arange(int(0.65 * rate)) / rate
            tone = sum(gain * np.sin(2 * np.pi * frequency * harmonic * t)
                       for harmonic, gain in ((1, 0.5), (2, 0.2), (3, 0.1)))
            tone *= np.exp(-4 * t) * np.minimum(t / 0.005, 1)
            start = int(onset * rate)
            samples[start:start + len(t)] += tone.astype(np.float32)
        wavfile.write(audio, rate, samples)
        result = subprocess.run(
            [sys.executable, "-I", "-B", str(pathlib.Path(__file__).with_name("transkun_runner.py")),
             str(audio), str(midi), "--device", device], capture_output=True, text=True,
            timeout=180, creationflags=0x08004000 if sys.platform == "win32" else 0)
        if result.returncode:
            raise RuntimeError(result.stderr.strip()[-700:] or "The model check did not complete.")
        if not midi.is_file() or not any(part.notes for part in pretty_midi.PrettyMIDI(str(midi)).instruments):
            raise RuntimeError("The model check produced no piano notes.")


def check(inference=False):
    if sys.version_info < (3, 10) or struct.calcsize("P") != 8:
        raise ValueError("Choose a 64-bit Python 3.10 or newer environment.")
    for name in ("flask", "flask_wtf", "flask_talisman", "werkzeug", "yt_dlp",
                 "requests", "pretty_midi", "numpy", "scipy", "torch", "torchaudio",
                 "transkun.transcribe", "moduleconf", "pkg_resources", "soxr", "pydub"):
        try:
            importlib.import_module(name)
        except Exception as error:
            raise ValueError(f"Cannot load {name}: {error}") from error
    import torch
    import transkun
    import moduleconf
    pretrained = pathlib.Path(transkun.__file__).parent / "pretrained"
    for name in ("2.0.pt", "2.0.conf"):
        path = pretrained / name
        if not path.is_file() or not path.stat().st_size:
            raise ValueError(f"Transkun model file is missing: {path}")
    moduleconf.parseFromFile(str(pretrained / "2.0.conf"))
    tools = {}
    for name in ("ffmpeg", "ffprobe"):
        path = shutil.which(name)
        if not path:
            raise ValueError(f"{name} not found. Install FFmpeg or add its bin folder to PATH.")
        result = subprocess.run([path, "-version"], capture_output=True, text=True,
                                timeout=10, creationflags=0x08000000 if sys.platform == "win32" else 0)
        if result.returncode or not result.stdout.startswith(name + " version"):
            raise ValueError(f"{name} could not run: {path}")
        tools[name] = str(pathlib.Path(path).resolve())
    if inference:
        try:
            check_model("cpu")
        except Exception as error:
            raise ValueError(f"The CPU model check failed: {error}") from error
    devices = ["cpu"]
    cuda_available, cuda_error = False, None
    if torch.version.cuda:
        try:
            if not torch.cuda.is_available():
                raise RuntimeError("CUDA is installed but no usable NVIDIA GPU was detected.")
            torch.zeros(1, device="cuda").cpu()
            if inference:
                check_model("cuda")
            cuda_available = True
            devices.append("cuda")
        except Exception as error:
            cuda_error = str(error)
    mps_available, mps_error = False, None
    mps = getattr(getattr(torch, "backends", None), "mps", None)
    if sys.platform == "darwin" and mps and mps.is_available():
        try:
            torch.zeros(1, device="mps").cpu()
            if inference:
                check_model("mps")
            mps_available = True
            devices.append("mps")
        except Exception as error:
            mps_error = str(error)
    try:
        importlib.import_module("music21")
        piano_notation = True
    except Exception:
        piano_notation = False
    return dict(python=str(pathlib.Path(sys.executable).absolute()), piano_notation=piano_notation,
                python_version=".".join(map(str, sys.version_info[:3])),
                torch_version=torch.__version__, cuda_available=cuda_available,
                cuda_error=cuda_error, mps_available=mps_available, mps_error=mps_error,
                devices=devices, **tools)


if __name__ == "__main__":
    try:
        print(json.dumps(check(inference="--inference" in sys.argv)))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
