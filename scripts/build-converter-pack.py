"""Build a relocatable Windows runtime, including licenses and the Transkun model."""
import argparse
import hashlib
import importlib.metadata
import json
import pathlib
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
VERSION = "1"
PYTHON = "3.13.13"
PYTHON_SHA = "8766a8775746235e23cf5aee5027ab1060bb981d93110577adcf3508aa0cbd55"

def digest(path):
    h=hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""): h.update(chunk)
    return h.hexdigest()

def download(url, path, expected=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        urllib.request.urlretrieve(url, path)
    if expected and digest(path) != expected:
        raise ValueError(f"Checksum mismatch: {path}")

def split_pack(zip_path):
    # GitHub release assets must stay below 2 GiB; concatenate parts before extraction.
    if zip_path.stat().st_size < 1900 * 1024**2: return []
    parts=[]
    with zip_path.open("rb") as source:
        while source.tell() < zip_path.stat().st_size:
            path=zip_path.with_name(zip_path.name+f".part{len(parts)+1}")
            remaining=1024**3
            with path.open("wb") as out:
                while remaining:
                    chunk=source.read(min(1024**2,remaining))
                    if not chunk: break
                    out.write(chunk);remaining-=len(chunk)
            parts.append({"file":path.name,"bytes":path.stat().st_size,"sha256":digest(path),"url":None})
    return parts

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("variant", choices=["cpu", "cuda"])
    parser.add_argument("--ffmpeg", type=pathlib.Path, default=pathlib.Path("C:/ffmpeg"))
    args = parser.parse_args()
    stage = ROOT / "target" / f"converter-{args.variant}-{VERSION}"
    stage.mkdir(parents=True, exist_ok=True)
    python_dir = stage / "python"
    cache = ROOT / "target" / "converter-downloads"
    archive = cache / f"python-{PYTHON}-embed-amd64.zip"
    download(f"https://www.python.org/ftp/python/{PYTHON}/{archive.name}", archive, PYTHON_SHA)
    if not python_dir.exists():
        python_dir.mkdir()
        with zipfile.ZipFile(archive) as z: z.extractall(python_dir)
    (python_dir / "python313._pth").write_text("python313.zip\n.\nLib/site-packages\nimport site\n")
    packages = python_dir / "Lib/site-packages"
    packages.mkdir(parents=True, exist_ok=True)
    import pip
    if not (packages / "pip").exists():
        shutil.copytree(pathlib.Path(pip.__file__).parent, packages / "pip")
    exe = python_dir / "python.exe"
    def install(*arguments):
        subprocess.run([str(exe), "-X", "utf8", "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "--progress-bar", "off", *arguments], check=True)
    torch_index = "cpu" if args.variant == "cpu" else "cu128"
    install(f"torch==2.9.1+{torch_index}", f"torchaudio==2.9.1+{torch_index}", "--index-url", f"https://download.pytorch.org/whl/{torch_index}")
    install("transkun==2.0.1", "Flask==3.1.3", "Flask-WTF==1.2.2", "flask-talisman==1.1.0", "yt-dlp[default]==2026.8.19", "curl_cffi==0.14.0", "requests==2.32.5", "setuptools==80.9.0", "scipy==1.17.1")
    # Check imports and model inclusion before making a distributable archive.
    subprocess.run([str(exe), "-X", "utf8", "-c", "import torch,torchaudio,transkun,scipy,flask,pretty_midi; from pathlib import Path; p=Path(transkun.__file__).parent; assert list(p.rglob('*.pt')) or list(p.rglob('*.pth')); print(torch.__version__)"], check=True)
    ffmpeg = stage / "ffmpeg"
    ffmpeg.mkdir(exist_ok=True)
    for name in ("ffmpeg.exe", "ffprobe.exe"):
        shutil.copy2(args.ffmpeg / "bin" / name, ffmpeg / name)
    licenses = stage / "licenses"
    licenses.mkdir(exist_ok=True)
    for name in ("LICENSE", "README.txt"):
        shutil.copy2(args.ffmpeg / name, licenses / ("FFmpeg-" + name))
    source = cache / "FFmpeg-source-1b62f9d3ae.zip"
    download("https://codeload.github.com/FFmpeg/FFmpeg/zip/1b62f9d3ae", source)
    shutil.copy2(source, licenses / source.name)
    shutil.copy2(ROOT / "converter/LICENSE", licenses / "mp3converter-LICENSE")
    freeze = subprocess.check_output([str(exe), "-X", "utf8", "-m", "pip", "freeze"], text=True)
    (stage / "requirements-lock.txt").write_text(freeze)
    package = {"version": VERSION, "variant": args.variant, "platform": "windows-x86_64", "python": PYTHON}
    (stage / "pack.json").write_text(json.dumps(package, indent=2))
    output = ROOT / "target/converter-packs"
    output.mkdir(exist_ok=True)
    zip_path = output / f"lazymidi-converter-{args.variant}-{VERSION}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as z:
        for path in sorted(stage.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts: z.write(path, path.relative_to(stage))
    package.update({"bytes": zip_path.stat().st_size, "installed_bytes": sum(i.file_size for i in zipfile.ZipFile(zip_path).infolist()), "sha256": digest(zip_path), "file": zip_path.name, "url": None, "parts": split_pack(zip_path)})
    (output / f"{args.variant}.json").write_text(json.dumps(package, indent=2))
    print(json.dumps(package, indent=2), flush=True)

if __name__ == "__main__": main()
