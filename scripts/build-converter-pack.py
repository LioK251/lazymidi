"""Build and qualify a relocatable converter runtime on its native platform."""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import uuid
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
VERSION = "2"
PYTHON = "3.11.18"
PYTHON_RELEASE = "20261026"
PYTHONS = {
    "windows-x86_64": ("x86_64-pc-windows-msvc", "67215a7bf1643e33d01b17ee3f1e91a8b0b39163746855ee02594bf0608f68b4"),
    "linux-x86_64": ("x86_64-unknown-linux-gnu", "17c4978a36c496dc53c08899ef8dad1ad2734f6325f08d6033a1e66419e0af26"),
    "macos-aarch64": ("aarch64-apple-darwin", "f3e1cd83a7f1d70e58b0d69102c18bd6867d2f973068dc5cbfd5822e445c66df"),
    "macos-x86_64": ("x86_64-apple-darwin", "d38edc2df25e7e7f886c802bf2fa552422b097c509dbdcbae828827470356095"),
}


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def download(url, path, expected):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        urllib.request.urlretrieve(url, path)
    if digest(path) != expected:
        raise ValueError(f"Checksum mismatch: {path}")


def split_pack(archive):
    if archive.stat().st_size < 1900 * 1024**2:
        return []
    parts = []
    with archive.open("rb") as source:
        while source.tell() < archive.stat().st_size:
            path = archive.with_name(archive.name + f".part{len(parts) + 1}")
            with path.open("wb") as output:
                for _ in range(1024):
                    chunk = source.read(1024**2)
                    if not chunk:
                        break
                    output.write(chunk)
            parts.append({"file": path.name, "bytes": path.stat().st_size,
                          "sha256": digest(path), "url": None})
    return parts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("variant", choices=("cpu", "cuda"))
    parser.add_argument("--ffmpeg", type=pathlib.Path, default=ROOT / "target/runtime-ffmpeg/install")
    args = parser.parse_args()
    system = {"win32": "windows", "darwin": "macos", "linux": "linux"}[sys.platform]
    arch = "aarch64" if platform.machine().lower() in ("arm64", "aarch64") else "x86_64"
    target = f"{system}-{arch}"
    if target not in PYTHONS or args.variant == "cuda" and system == "macos":
        raise ValueError("Unsupported runtime target")
    triple, checksum = PYTHONS[target]
    stage = ROOT / "target" / f"converter-{target}-{args.variant}-{VERSION}"
    stage.mkdir(parents=True, exist_ok=True)
    cache = ROOT / "target/runtime-downloads"
    python_archive = f"cpython-{PYTHON}+{PYTHON_RELEASE}-{triple}-install_only_stripped.tar.gz"
    archive = cache / python_archive
    download(f"https://github.com/astral-sh/python-build-standalone/releases/download/{PYTHON_RELEASE}/{python_archive}", archive, checksum)
    if not (stage / "python").exists():
        with tarfile.open(archive) as source:
            source.extractall(stage, filter="data")
    python_relative = "python/python.exe" if system == "windows" else "python/bin/python3"
    executable = stage / python_relative
    if not executable.is_file():
        raise ValueError(f"Missing standalone interpreter: {executable}")
    environment = {**os.environ, "PIP_DISABLE_PIP_VERSION_CHECK": "1", "PIP_NO_CACHE_DIR": "1",
                   "PYTHONDONTWRITEBYTECODE": "1", "OMP_NUM_THREADS": "2",
                   "OPENBLAS_NUM_THREADS": "2", "MKL_NUM_THREADS": "2"}

    def run(*arguments, **kwargs):
        return subprocess.run([str(executable), "-I", "-B", *arguments], env=environment, check=True, **kwargs)

    run("-m", "ensurepip", "--upgrade")
    run("-m", "pip", "install", "--progress-bar", "off", "numpy==1.26.4", "setuptools==80.9.0", "wheel==0.45.1", "Cython==3.1.4")
    torch = "2.2.2" if target == "macos-x86_64" else "2.9.1"
    index = "cu128" if args.variant == "cuda" else "cpu"
    suffix = "" if system == "macos" else f"+{index}"
    torch_args = [] if system == "macos" else ["--index-url", f"https://download.pytorch.org/whl/{index}"]
    run("-m", "pip", "install", "--progress-bar", "off", f"torch=={torch}{suffix}", f"torchaudio=={torch}{suffix}", *torch_args)
    # Intel macOS has no published ncls wheel; compile it here so users need no compiler.
    run("-m", "pip", "install", "--no-build-isolation", "--progress-bar", "off", "ncls==0.0.71")
    run("-m", "pip", "install", "--progress-bar", "off", "numpy==1.26.4", "transkun==2.0.1",
        "Flask==3.1.3", "Flask-WTF==1.2.2", "flask-talisman==1.1.0", "yt-dlp[default]==2026.8.19",
        "curl_cffi==0.14.0", "requests==2.32.5", "setuptools==80.9.0", "scipy==1.17.1", "music21==9.7.1")
    run("-m", "pip", "uninstall", "-y", "Cython", "wheel")
    run("-m", "pip", "check")
    (stage / "requirements-lock.txt").write_text(run("-m", "pip", "freeze", capture_output=True, text=True).stdout, encoding="utf-8")
    ffmpeg = stage / "ffmpeg"
    ffmpeg.mkdir(exist_ok=True)
    for tool in ("ffmpeg", "ffprobe"):
        name = tool + (".exe" if system == "windows" else "")
        shutil.copy2(args.ffmpeg / "bin" / name, ffmpeg / name)
        if system != "windows":
            (ffmpeg / name).chmod(0o755)
    licenses = stage / "licenses"
    shutil.copytree(args.ffmpeg / "licenses", licenses / "ffmpeg", dirs_exist_ok=True)
    shutil.copy2(ROOT / "converter/LICENSE", licenses / "mp3converter-LICENSE")
    (licenses / "Python-provenance.txt").write_text(
        f"CPython {PYTHON}; python-build-standalone {PYTHON_RELEASE}.\n{python_archive}\n"
        f"Source and build recipes: https://github.com/astral-sh/python-build-standalone/tree/{PYTHON_RELEASE}\n"
        "Python and package licenses are retained in the python directory and distribution metadata.\n", encoding="utf-8")
    # Relocation must work before archiving; no Python path may depend on the build directory.
    relocated = stage.with_name(stage.name + "-qualified-" + uuid.uuid4().hex[:8])
    assert stage.resolve().is_relative_to((ROOT / "target").resolve())
    assert relocated.resolve().is_relative_to((ROOT / "target").resolve())
    stage.rename(relocated)
    stage = relocated
    executable = stage / python_relative
    environment["PATH"] = str(stage / "ffmpeg") + os.pathsep + environment.get("PATH", "")
    run(str(ROOT / "converter/check_environment.py"), "--inference")
    run(str(ROOT / "converter/test_piano_sheet.py"))
    environment["LAZYMIDI_TEST_TRANSCRIPTION"] = "cpu"
    run(str(ROOT / "converter/test_service.py"))
    package = {"version": VERSION, "variant": args.variant, "platform": target, "python": PYTHON}
    (stage / "pack.json").write_text(json.dumps(package, indent=2), encoding="utf-8")
    output = ROOT / "target/converter-packs"
    output.mkdir(exist_ok=True)
    archive = output / f"lazymidi-converter-{target}-{args.variant}-{VERSION}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=3, allowZip64=True) as zipped:
        for path in sorted(stage.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                if not path.resolve().is_relative_to(stage.resolve()):
                    raise ValueError(f"Runtime link escapes its directory: {path}")
                zipped.write(path, path.relative_to(stage))
    with zipfile.ZipFile(archive) as zipped:
        assert zipped.testzip() is None
        installed = sum(entry.file_size for entry in zipped.infolist())
    package.update(bytes=archive.stat().st_size, installed_bytes=installed, sha256=digest(archive),
                   file=archive.name, url=None, parts=split_pack(archive))
    (output / f"{target}-{args.variant}.json").write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(package, indent=2), flush=True)


if __name__ == "__main__":
    main()
