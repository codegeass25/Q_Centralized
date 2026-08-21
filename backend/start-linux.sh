#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created backend/.env. Edit OFFICE_ACCESS_CODE and REPORT_ADMIN_PASSWORD, then run this script again."
  exit 0
fi
if [ ! -d node_modules ]; then
  npm install
fi
node server.js
