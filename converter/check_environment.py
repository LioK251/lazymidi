"""Read-only compatibility check, run by the selected Python interpreter."""
import importlib
import json
import pathlib
import shutil
import struct
import subprocess
import sys


def check():
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
    cuda_available, cuda_error = False, None
    if torch.version.cuda:
        try:
            if not torch.cuda.is_available():
                raise RuntimeError("CUDA is installed but no usable NVIDIA GPU was detected.")
            torch.zeros(1, device="cuda").cpu()
            cuda_available = True
        except Exception as error:
            cuda_error = str(error)
    return dict(python=str(pathlib.Path(sys.executable).absolute()),
                python_version=".".join(map(str, sys.version_info[:3])),
                torch_version=torch.__version__, cuda_available=cuda_available,
                cuda_error=cuda_error, **tools)


if __name__ == "__main__":
    try:
        print(json.dumps(check()))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
