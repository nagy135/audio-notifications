#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
TEST_DIR=$(mktemp -d)
FIXTURE_PID=""
cleanup() {
    if [ -n "$FIXTURE_PID" ]; then
        kill "$FIXTURE_PID" 2>/dev/null || true
        wait "$FIXTURE_PID" 2>/dev/null || true
    fi
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT
xcrun swiftc -parse-as-library apps/macos/Sources/{API,Storage,SpeechPlayer,Listener}.swift \
    apps/macos/Tests/Integration.swift -o "$TEST_DIR/integration" \
    -target "$(uname -m)-apple-macosx13.0" -framework AVFoundation -framework Security
node apps/macos/Tests/fixture.mjs "$TEST_DIR/config.json" > "$TEST_DIR/fixture.log" 2>&1 &
FIXTURE_PID=$!
for attempt in {1..100}; do
    if [ -f "$TEST_DIR/config.json" ]; then break; fi
    if ! kill -0 "$FIXTURE_PID" 2>/dev/null; then cat "$TEST_DIR/fixture.log"; exit 1; fi
    sleep 0.05
done
"$TEST_DIR/integration" "$TEST_DIR/config.json" "$TEST_DIR/receipts"
