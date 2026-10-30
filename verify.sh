#!/usr/bin/env bash
# Read-only live check: tenant token and bot info; add "--ws 20" to open the long connection for 20 s. Sends nothing.
cd "$(dirname "$0")" || exit 1
exec "${NODE:-node}" bin/verify.js "$@"
