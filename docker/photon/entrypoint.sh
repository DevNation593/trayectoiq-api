#!/bin/sh
# Arranque de Photon para TrayectoIQ.
#
# La imagen rtuszik/photon-docker solo sabe descargar indices precompilados, y para Ecuador no
# existe uno: el espejo oficial publica unicamente el volcado JSONL. Este script usa el photon.jar
# y el Python de la imagen para construir el indice desde ese volcado la primera vez (unos minutos)
# y despues solo sirve.
set -eu

DATA_DIR=/photon/data
DUMP_URL="${PHOTON_DUMP_URL:-https://download1.graphhopper.com/public/south-america/ecuador/photon-dump-ecuador-1.0-latest.jsonl.zst}"
LANGUAGES="${PHOTON_LANGUAGES:-es,en}"

if [ ! -f "$DATA_DIR/.import-complete" ]; then
  echo "[photon] Descargando volcado: $DUMP_URL"
  curl -fsSL "$DUMP_URL" -o /tmp/dump.jsonl.zst

  echo "[photon] Descomprimiendo"
  /photon/.venv/bin/python3 - <<'PY'
import zstandard

with open("/tmp/dump.jsonl.zst", "rb") as source, open("/tmp/dump.jsonl", "wb") as target:
    zstandard.ZstdDecompressor().copy_stream(source, target)
PY
  rm -f /tmp/dump.jsonl.zst

  echo "[photon] Construyendo el indice (idiomas: $LANGUAGES)"
  rm -rf "$DATA_DIR/photon_data"
  java -jar /photon/photon.jar import -data-dir "$DATA_DIR" -import-file /tmp/dump.jsonl -languages "$LANGUAGES"
  rm -f /tmp/dump.jsonl
  touch "$DATA_DIR/.import-complete"
  echo "[photon] Indice listo"
fi

exec java -jar /photon/photon.jar serve -data-dir "$DATA_DIR" -listen-ip 0.0.0.0
