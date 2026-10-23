#!/bin/sh
# muse-bridge-mcp - instalador de un solo comando.
#   curl -fsSL https://raw.githubusercontent.com/MartoneWorkshop/muse-bridge-connect/main/install.sh | sh
# Instala el CLI globalmente con npm y lanza el asistente de configuracion
# (setup), que te pide los datos una sola vez y los deja guardados en
# ~/.config/muse-bridge-mcp/config.json. Sin variables de entorno.
# Flags extra (opcionales) pasan al asistente, p. ej.:
#   sh -s -- --username mi-agente --password-file ./mi-clave.txt
set -e

main() {
  command -v node >/dev/null 2>&1 || { echo "x Falta Node.js (>= 18): https://nodejs.org" >&2; exit 1; }
  command -v npm >/dev/null 2>&1 || { echo "x Falta npm (viene con Node.js)" >&2; exit 1; }

  echo "-> Instalando muse-bridge-mcp (npm install -g github:MartoneWorkshop/muse-bridge-connect)..."
  npm install -g github:MartoneWorkshop/muse-bridge-connect

  echo "-> Configurando tu conexion..."
  if [ -e /dev/tty ]; then
    exec muse-bridge-mcp setup "$@" < /dev/tty
  else
    exec muse-bridge-mcp setup "$@"
  fi
}

main "$@"
