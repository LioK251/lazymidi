#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$root/target/runtime-ffmpeg"
prefix="$work/dependencies"
output="$work/install"
mkdir -p "$work/sources" "$prefix" "$output/licenses"
jobs="$(python -c 'import os; print(min(os.cpu_count() or 2, 4))')"

fetch() {
  local url="$1" name="$2" checksum="$3"
  if [ ! -f "$work/sources/$name" ]; then
    curl --fail --location --retry 3 "$url" --output "$work/sources/$name"
  fi
  python - "$work/sources/$name" "$checksum" <<'PY'
import hashlib, pathlib, sys
path = pathlib.Path(sys.argv[1])
assert hashlib.sha256(path.read_bytes()).hexdigest() == sys.argv[2], path
PY
  tar -xf "$work/sources/$name" -C "$work"
}
fetch https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz ffmpeg-8.1.3.tar.xz 7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
fetch https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz openssl-3.5.9.tar.gz 603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a
fetch https://distfiles.macports.org/lame/lame-3.100.tar.gz lame-3.100.tar.gz ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e

openssl_target=()
ffmpeg_target=()
ldflags="-L$prefix/lib"
case "$(uname -s)" in
  MINGW*|MSYS*)
    openssl_target=(mingw64)
    ffmpeg_target=(--target-os=mingw32 --arch=x86_64)
    ldflags="$ldflags -static"
    ;;
  Darwin) export MACOSX_DEPLOYMENT_TARGET=14.0 ;;
esac
cd "$work/openssl-3.5.9"
perl ./Configure ${openssl_target[@]+"${openssl_target[@]}"} no-shared no-tests --prefix="$prefix" --libdir=lib
make -j"$jobs"
make install_sw
cd "$work/lame-3.100"
./configure --prefix="$prefix" --disable-shared --enable-static --disable-frontend --with-pic
make -j"$jobs"
make install
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
cd "$work/ffmpeg-8.1.3"
./configure --prefix="$output" --disable-autodetect --disable-gpl --disable-nonfree \
  --disable-shared --enable-static --disable-doc --disable-debug --disable-ffplay \
  --enable-openssl --enable-version3 --enable-libmp3lame --pkg-config-flags=--static \
  --extra-cflags="-I$prefix/include" --extra-ldflags="$ldflags" ${ffmpeg_target[@]+"${ffmpeg_target[@]}"}
make -j"$jobs"
make install
"$output/bin/ffmpeg" -version > "$output/licenses/FFmpeg-build.txt"
"$output/bin/ffmpeg" -L >> "$output/licenses/FFmpeg-build.txt" 2>&1
"$output/bin/ffprobe" -version >> "$output/licenses/FFmpeg-build.txt"
cp "$work/ffmpeg-8.1.3/COPYING.LGPLv3" "$output/licenses/FFmpeg-LGPL-3.0.txt"
cp "$work/openssl-3.5.9/LICENSE.txt" "$output/licenses/OpenSSL-LICENSE.txt"
cp "$work/lame-3.100/COPYING" "$output/licenses/LAME-LICENSE.txt"
cp "$root/scripts/build-runtime-ffmpeg.sh" "$output/licenses/"
cp "$work/sources/"* "$output/licenses/"
printf '%s\n' 'FFmpeg 8.1.3, OpenSSL 3.5.9 and LAME 3.100.' \
  'Built with GPL and nonfree components disabled; OpenSSL requires LGPL version 3.' \
  'Matching source archives and the complete build script are included here.' \
  'Build tools: a C compiler, make, Perl, NASM, pkg-config, curl, tar and Python 3.' \
  'Windows: run from MSYS2 UCRT64 with its compiler toolchain and pkg-config.' \
  'The compiler runtime uses its standard system-library/runtime-exception terms.' \
  > "$output/licenses/README.txt"
if [ -d /ucrt64/share/licenses/gcc ]; then
  cp -R /ucrt64/share/licenses/gcc "$output/licenses/compiler-runtime"
fi
