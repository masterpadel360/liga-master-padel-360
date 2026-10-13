#!/usr/bin/env bash
# Sube la versión de la app para que todos los celulares se actualicen solos.
# Uso: ./nueva-version.sh            (usa fecha de hoy + letra siguiente)
#      ./nueva-version.sh 20261020a  (versión a mano)
set -euo pipefail
cd "$(dirname "$0")"
ACTUAL=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' version.json)
if [ $# -ge 1 ]; then NUEVA="$1"; else
  HOY=$(date +%Y%m%d); L=a
  if [ "${ACTUAL:0:8}" = "$HOY" ]; then L=$(echo "${ACTUAL:8:1}" | tr 'a-y' 'b-z'); fi
  NUEVA="$HOY$L"
fi
sed -i -E "s/\?v=[0-9]{8}[a-z]/?v=$NUEVA/g; s/window\.APP_VERSION = '[^']*'/window.APP_VERSION = '$NUEVA'/" index.html
printf '{ "version": "%s" }\n' "$NUEVA" > version.json
echo "Versión: $ACTUAL -> $NUEVA"
