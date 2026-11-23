#!/usr/bin/env bash
# Local kill -9 demo (SPEC acceptance test 7): start the agent under Bun,
# kill -9 it mid-tool-call, reopen in a fresh process, and Resume.
# Prints the full transcript of both scenarios. Needs OPENAI_API_KEY.
set -u
cd "$(dirname "$0")/.."

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "OPENAI_API_KEY is not set; the demo runs the real agent and needs it." >&2
  exit 2
fi

fail=0
for scenario in safe unsafe; do
  db="$(mktemp -u /tmp/pi-durable-demo-${scenario}.XXXXXX.sqlite)"
  log="$(mktemp /tmp/pi-durable-demo-${scenario}.XXXXXX.log)"
  echo "=== scenario: ${scenario} (db: ${db}) ==="
  bun run scripts/local-kill-demo.ts child "${db}" "${scenario}" >"${log}" 2>&1 &
  child=$!
  # Wait for the tool to be running (and, for unsafe, the ledger to be committed).
  marker="TOOL RUNNING"
  [ "${scenario}" = "unsafe" ] && marker="LEDGER COMMITTED"
  for _ in $(seq 1 240); do
    grep -q "${marker}" "${log}" 2>/dev/null && break
    kill -0 "${child}" 2>/dev/null || break
    sleep 0.25
  done
  if ! grep -q "${marker}" "${log}"; then
    echo "child never reached the marker; its output:" >&2
    cat "${log}" >&2
    kill -9 "${child}" 2>/dev/null
    fail=1
    continue
  fi
  cat "${log}"
  echo "--- kill -9 ${child} ---"
  kill -9 "${child}"
  wait "${child}" 2>/dev/null
  echo "--- reopening and resuming ---"
  bun run scripts/local-kill-demo.ts resume "${db}" "${scenario}" || fail=1
  rm -f "${db}" "${db}-wal" "${db}-shm" "${log}"
done

if [ "${fail}" = "0" ]; then
  echo "=== local kill demo: PASS (safe tool reran; unsafe tool interrupted, ledger exactly one entry) ==="
else
  echo "=== local kill demo: FAIL ===" >&2
fi
exit "${fail}"
