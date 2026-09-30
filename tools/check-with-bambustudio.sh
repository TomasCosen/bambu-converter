#!/bin/bash
# Slices a converted 3MF with the real Bambu Studio command line to confirm it loads as a project.
#
#   BAMBU_STUDIO=/path/to/squashfs-root tools/check-with-bambustudio.sh salida.3mf [carpeta]
#
# BAMBU_STUDIO points to an extracted Bambu Studio AppImage (./BambuStudio*.AppImage --appimage-extract).
# Needs xvfb-run and libwebkit2gtk-4.1-0 on Linux. Prints result.json; exit code 0 means it sliced.
set -u
BS=${BAMBU_STUDIO:?set BAMBU_STUDIO to the extracted AppImage directory}
in=$1
out=${2:-$(mktemp -d)}
mkdir -p "$out"
export LD_LIBRARY_PATH="$BS/bin" LC_ALL=C
timeout 300 xvfb-run -a "$BS/bin/bambu-studio" --datadir "$out/datadir" --debug 2 --slice 0 \
  --outputdir "$out" --export-settings "$out/settings.json" "$in" > "$out/log.txt" 2>&1
code=$?
cat "$out/result.json" 2>/dev/null | head -12
echo "exit=$code  (log: $out/log.txt)"
exit $code
