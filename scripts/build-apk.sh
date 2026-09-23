#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17)}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
signing_dir="${AUDIO_SIGNING_DIR:-$HOME/.config/audio-notifications}"
mkdir -p "$signing_dir"
chmod 700 "$signing_dir"
if [[ ! -f "$signing_dir/signing.env" ]]; then
  (umask 077; python3 - "$signing_dir" <<'PY'
import secrets,sys,shlex
from pathlib import Path
p=Path(sys.argv[1]); password=secrets.token_hex(32)
(p/'signing.env').write_text('export AUDIO_KEYSTORE='+shlex.quote(str(p/'release.keystore'))+'\nexport AUDIO_KEY_PASSWORD='+shlex.quote(password)+'\n')
PY
  )
fi
source "$signing_dir/signing.env"
if [[ ! -f "$AUDIO_KEYSTORE" ]]; then
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$AUDIO_KEYSTORE" -storepass:env AUDIO_KEY_PASSWORD -keypass:env AUDIO_KEY_PASSWORD -alias audio-notifications -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Audio Notifications, O=Infiniter' -noprompt
  chmod 600 "$AUDIO_KEYSTORE"
fi
(cd apps/mobile && CI=1 npx expo prebuild --platform android --no-install)
(cd apps/mobile/android && ./gradlew assembleRelease -PreactNativeArchitectures="${AUDIO_ABIS:-arm64-v8a,armeabi-v7a}" --console=plain)
mkdir -p artifacts
cp apps/mobile/android/app/build/outputs/apk/release/app-release.apk artifacts/audio-notifications-1.0.0.apk
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs artifacts/audio-notifications-1.0.0.apk
shasum -a 256 artifacts/audio-notifications-1.0.0.apk
