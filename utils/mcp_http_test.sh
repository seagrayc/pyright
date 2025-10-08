#!/usr/bin/env bash
set -euo pipefail

# Curl-based helper to send MCP JSON-RPC messages to the SSE server.
# The SSE server must already be running (VS Code launch: Pyright MCP Server (SSE)),
# and you must provide the active sessionId from the /sse connection.

# Usage:
#   export SESSION_ID=5285ea08-ae18-412c-b978-e5377b346a51
#   bash utils/mcp_http_test.sh init
#   bash utils/mcp_http_test.sh list
#   bash utils/mcp_http_test.sh call initialize_project '{"project_root":"/home/brent/repos/OpenHands","python_path":"/home/brent/.cache/pypoetry/virtualenvs/openhands-ai-kMiABEKe-py3.12/bin"}'
#   bash utils/mcp_http_test.sh call get_call_stack '{"file_path":"openhands/core/main.py","line_number":284,"my_code_max_depth":4,"not_my_code_max_depth":1}'
#   bash utils/mcp_http_test.sh shutdown
#   bash utils/mcp_http_test.sh exit
#   echo '{...}' | bash utils/mcp_http_test.sh send -
#   # or pass SESSION_ID explicitly (overrides env):
#   bash utils/mcp_http_test.sh <SESSION_ID> init

BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT:-3333}}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 [SESSION_ID] <init|shutdown|exit|send> [@file|-]" >&2
  echo "       SESSION_ID can be provided via env (export SESSION_ID=...) or as the first arg." >&2
  exit 2
fi

# Determine whether first arg is the command or the SESSION_ID
case "${1}" in
  init|list|shutdown|exit|send|call)
    CMD="$1"
    shift 1
    SESSION_ID="${SESSION_ID:-}"
    ;;
  *)
    SESSION_ID="$1"
    CMD="${2:-}"
    shift 2 || true
    ;;
esac

if [[ -z "${SESSION_ID}" ]]; then
  echo "SESSION_ID is required. Set env SESSION_ID or pass it as the first argument." >&2
  exit 2
fi

if [[ -z "${CMD}" ]]; then
  echo "Missing command. Use one of: init|shutdown|exit|send" >&2
  exit 2
fi

TARGET_URL="${BASE_URL}/message?sessionId=${SESSION_ID}"

post_body() {
  local body="$1"
  curl -sS -X POST -H 'Content-Type: application/json' --data-binary "${body}" "${TARGET_URL}"
}

post_from_file() {
  local file="$1"
  curl -sS -X POST -H 'Content-Type: application/json' --data-binary @"${file}" "${TARGET_URL}"
}

case "${CMD}" in
  init)
    BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"curl-client","version":"0.1.0"},"capabilities":{}}}'
    post_body "${BODY}" >/dev/null
    echo "sent initialize to ${TARGET_URL}" >&2
    ;;
  list)
    BODY='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
    post_body "${BODY}" >/dev/null
    echo "sent tools/list to ${TARGET_URL}" >&2
    ;;
  shutdown)
    BODY='{"jsonrpc":"2.0","id":2,"method":"shutdown","params":null}'
    post_body "${BODY}" >/dev/null
    echo "sent shutdown to ${TARGET_URL}" >&2
    ;;
  exit)
    BODY='{"jsonrpc":"2.0","method":"exit","params":null}'
    post_body "${BODY}" >/dev/null
    echo "sent exit to ${TARGET_URL}" >&2
    ;;
  call)
    if [[ $# -lt 1 ]]; then
      echo "call requires a tool name and optional arguments JSON (string, @file, or -)" >&2
      echo "Example: bash $0 call initialize_project '{\"project_root\":\"/home/user/myproject\",\"python_path\":\"/home/user/.venv/bin/python\"}'" >&2
      exit 2
    fi
    NAME="$1"; shift 1 || true
    if [[ $# -ge 1 ]]; then
      SRC="$1"
      if [[ "${SRC}" == @* ]]; then
        ARGS_CONTENT="$(cat "${SRC#@}")"
      else
        if [[ "${SRC}" == "-" ]]; then
          ARGS_CONTENT="$(cat)"
        else
          ARGS_CONTENT="${SRC}"
        fi
      fi
    else
      ARGS_CONTENT='{}'
    fi
    BODY='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"'"${NAME}"'","arguments":'"${ARGS_CONTENT}"'}}'
    post_body "${BODY}" >/dev/null
    echo "sent tools/call(${NAME}) to ${TARGET_URL}" >&2
    ;;
  send)
    if [[ $# -lt 1 ]]; then
      echo "send requires a JSON source: @file or - (stdin)" >&2
      exit 2
    fi
    SRC="$1"
    if [[ "${SRC}" == @* ]]; then
      post_from_file "${SRC#@}" >/dev/null
    else
      # read from stdin if '-'; otherwise treat as literal JSON string
      if [[ "${SRC}" == "-" ]]; then
        BODY="$(cat)"
      else
        BODY="${SRC}"
      fi
      post_body "${BODY}" >/dev/null
    fi
    echo "sent custom payload to ${TARGET_URL}" >&2
    ;;
  *)
    echo "Unknown command: ${CMD}" >&2
    exit 2
    ;;
esac

echo "Note: responses are delivered over the SSE stream (GET ${BASE_URL}/sse)." >&2


