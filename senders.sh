#!/usr/bin/env bash
# List recent sender open_ids (no names) to find the value for OWNER_ID.
cd "$(dirname "$0")" || exit 1
exec "${NODE:-node}" bin/senders.js "$@"
