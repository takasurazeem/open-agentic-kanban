#!/usr/bin/env bash
# Render public/icon.svg to public/icon.png and build/icon.icns (needs rsvg-convert, macOS iconutil).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/icon.iconset
rsvg-convert -w 512 -h 512 public/icon.svg -o public/icon.png
for s in 16 32 128 256 512; do
  rsvg-convert -w $s -h $s public/icon.svg -o build/icon.iconset/icon_${s}x${s}.png
  rsvg-convert -w $((s * 2)) -h $((s * 2)) public/icon.svg -o build/icon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns build/icon.iconset -o build/icon.icns
rm -rf build/icon.iconset
echo "Wrote public/icon.png and build/icon.icns"
