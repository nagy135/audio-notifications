#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

APP="$PWD/build/Audio Notifications.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
xcrun swiftc -parse-as-library Sources/*.swift \
    -o "$APP/Contents/MacOS/AudioNotifications" \
    -target "$(uname -m)-apple-macosx13.0" \
    -framework AppKit -framework SwiftUI -framework AVFoundation -framework Security -O
cp Resources/Info.plist "$APP/Contents/Info.plist"
xcrun swift scripts/make-icon.swift "$PWD/build"
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - --identifier local.audio-notifications.macos "$APP"
echo "Built $APP"
