"""Install Converter dependencies into the private Python created by Runtime setup."""
import argparse
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys


def install(stage, tools, variant):
    expected = stage / ("python/python.exe" if sys.platform == "win32" else "python/bin/python3")
    if pathlib.Path(sys.executable).resolve() != expected.resolve() or sys.version_info[:2] != (3, 11):
        raise ValueError("Setup must run inside its private Python 3.11 environment.")
    if variant not in ("cpu", "cuda") or variant == "cuda" and sys.platform == "darwin":
        raise ValueError("This processing option is not supported on this computer.")
    wheels = list(tools.glob("ncls-0.0.71-*.whl"))
    if len(wheels) != 1:
        raise ValueError("The app is missing a required setup file. Reinstall lazymidi.")
    work = stage / "setup-temp"
    work.mkdir()
    environment = {**os.environ, "TMP": str(work), "TEMP": str(work), "TMPDIR": str(work),
                   "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1",
                   "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2"}

    def phase(name):
        temp = stage / "setup-phase.tmp"
        temp.write_text(json.dumps(name), encoding="utf-8")
        temp.replace(stage / "setup-phase.json")
        print(name, flush=True)

    def run(*args, **kwargs):
        return subprocess.run([sys.executable, "-I", "-B", "-X", "utf8", *args],
                              env=environment, check=True, **kwargs)

    def pip(*args):
        run("-m", "pip", "--isolated", "--disable-pip-version-check", "--no-cache-dir", *args)

    def packages(*requirements, index="https://pypi.org/simple"):
        pip("install", "--no-input", "--no-compile", "--progress-bar", "off", "--timeout", "30",
            "--retries", "3", "--index-url", index, *requirements)

    try:
        phase("python-packages")
        run("-m", "ensurepip", "--upgrade")
        packages("numpy==1.26.4", "setuptools==80.9.0", str(wheels[0]))
        phase("torch")
        if sys.platform == "darwin":
            torch = "2.2.2" if platform.machine() == "x86_64" else "2.9.1"
            packages(f"torch=={torch}", f"torchaudio=={torch}")
        else:
            index = "cu128" if variant == "cuda" else "cpu"
            packages(f"torch==2.9.1+{index}", f"torchaudio==2.9.1+{index}",
                     index=f"https://download.pytorch.org/whl/{index}")
        phase("converter")
        packages("numpy==1.26.4", "setuptools==80.9.0", "transkun==2.0.1", "Flask==3.1.3",
                 "Flask-WTF==1.2.2", "flask-talisman==1.1.0", "yt-dlp[default]==2026.8.19",
                 "curl_cffi==0.14.0", "requests==2.32.5", "chardet==5.2.0", "scipy==1.17.1",
                 "music21==9.7.1")
        pip("check")
        run("-W", "error", "-c", "import requests")
        result = run("-m", "pip", "--isolated", "freeze", capture_output=True, text=True)
        (stage / "requirements-lock.txt").write_text(result.stdout, encoding="utf-8")
        ffmpeg = stage / "ffmpeg"
        ffmpeg.mkdir()
        for name in ("ffmpeg", "ffprobe"):
            name += ".exe" if sys.platform == "win32" else ""
            shutil.copy2(tools / name, ffmpeg / name)
            if sys.platform != "win32":
                (ffmpeg / name).chmod(0o755)
        shutil.copytree(tools / "licenses", stage / "licenses")
        (stage / "licenses/Python-source.txt").write_text(
            "CPython 3.11.18; python-build-standalone 20261026.\n"
            "Source/build recipes: https://github.com/astral-sh/python-build-standalone/tree/20261026\n"
            "Python and package licenses are retained in the Python directory and package metadata.\n",
            encoding="utf-8")
    finally:
        shutil.rmtree(work)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", type=pathlib.Path)
    parser.add_argument("tools", type=pathlib.Path)
    parser.add_argument("variant", choices=("cpu", "cuda"))
    args = parser.parse_args()
    install(args.stage.resolve(), args.tools.resolve(), args.variant)
