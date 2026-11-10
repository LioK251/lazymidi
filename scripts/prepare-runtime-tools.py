"""Prepare the small platform tools shipped with the desktop app (no Python or model)."""
import argparse
import hashlib
import pathlib
import shutil
import subprocess
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", type=pathlib.Path, default=ROOT / "target/runtime-ffmpeg/install")
    args = parser.parse_args()
    output = ROOT / "converter/runtime-tools"
    output.mkdir(exist_ok=True)
    for name in ("ffmpeg", "ffprobe"):
        name += ".exe" if sys.platform == "win32" else ""
        shutil.copy2(args.ffmpeg / "bin" / name, output / name)
        if sys.platform != "win32":
            (output / name).chmod(0o755)
    for source in (args.ffmpeg / "licenses").rglob("*"):
        if source.is_file() and not source.name.endswith((".tar.gz", ".tar.xz")):
            destination = output / "licenses" / source.relative_to(args.ffmpeg / "licenses")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    archive = args.ffmpeg / "licenses/ffmpeg-8.1.3.tar.xz"
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == "7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3"
    with tarfile.open(archive) as source:
        (output / "licenses/GPL-3.0.txt").write_bytes(source.extractfile("ffmpeg-8.1.3/COPYING.GPLv3").read())
    (output / "licenses/README.txt").write_text(
        "FFmpeg 8.1.3, OpenSSL 3.5.9 and LAME 3.100.\n"
        "GPL and nonfree components disabled; FFmpeg uses LGPL version 3.\n"
        "Matching source archives: https://lazymidi.vercel.app/third-party/\n"
        "The complete build recipe is included as build-runtime-ffmpeg.sh.\n"
        "You may replace the ffmpeg/ffprobe executables in an installed Converter runtime.\n",
        encoding="utf-8")
    if sys.version_info[:2] != (3, 11):
        raise ValueError("Build setup wheels with Python 3.11.")
    subprocess.run([sys.executable, "-m", "pip", "--isolated", "--no-cache-dir", "install",
                    "--index-url", "https://pypi.org/simple", "numpy==1.26.4", "setuptools==80.9.0",
                    "wheel==0.45.1", "Cython==3.1.4"], check=True)
    subprocess.run([sys.executable, "-m", "pip", "--isolated", "--no-cache-dir", "wheel",
                    "--index-url", "https://pypi.org/simple", "--no-deps", "--no-build-isolation",
                    "--wheel-dir", str(output), "ncls==0.0.71"], check=True)
    assert len(list(output.glob("ncls-0.0.71-*.whl"))) == 1
    assert sum(p.stat().st_size for p in output.rglob("*") if p.is_file()) < 90 * 1024**2


if __name__ == "__main__":
    main()
