#!/usr/bin/env bash
# Usage: ./reply.sh --to <sender_id|chat_id> --stdin <<'EOF_REPLY'   (recommended: text on stdin, no shell quoting issues)
#        ./reply.sh --to <sender_id|chat_id> -- "text"
#        ./reply.sh --to <sender_id|chat_id> --image|--file <file> [--stdin | -- "caption"]
#        ./reply.sh --reply-to <message_id> --stdin <<'EOF_REPLY'
#        --to owner sends to the bound owner. Run ./reply.sh --help for details.
export REPLY_CWD="$PWD"  # relative file paths resolve from the caller's directory
cd "$(dirname "$0")" || exit 1
exec "${NODE:-node}" bin/reply.js "$@"
