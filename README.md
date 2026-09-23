# Audio Notifications

An Expo / React Native Android app and a persistent Node.js notification server. Agents POST text; the phone reads it aloud with Kokoro neural speech, including while the screen is locked. The selected Android speech voice is used automatically when Kokoro cannot generate or play audio.

- `apps/mobile`: Expo SDK 55, React Native 0.83, a local Kotlin Expo module.
- `apps/server`: REST + WebSocket server, SQLite queue and delivery receipts.
- `apps/kokoro`: private CPU speech worker using the pinned Kokoro v1.0 float32 model and `kokoro-onnx` (float32 was faster than int8 on nixpi).
- `skills/audio-notify`: agent skill and Python REST client.
- `compose.yaml`: private Docker deployment on nixpi.

## Install and listen

1. Install the signed APK and connect Tailscale on the phone.
2. Enter the one-use pairing code. The prefilled server is `https://nixpi.tail6650cb.ts.net:8444`.
3. Allow notifications and background listening (battery optimization exemption), then tap **Start listening**.
4. Under **Primary voice**, Kokoro is enabled by default with **Heart**. Tap **Choose Kokoro voice** for ten American/British English voices, then preview while listening. Choices persist and apply to the next message. Turn Kokoro off to always use Android speech.
5. Under **Android fallback voice**, tap **Choose Android voice** to browse and search the current Android speech engine’s available voices. Each voice shows its language and whether it needs internet. **Test selected voice** here deliberately tests Android speech. **Automatic** prefers an installed offline voice in your phone’s language (falling back to US English).
6. Set media volume, then lock the phone. The persistent notification includes a Stop action.

Use **Android voice settings** to install voices or change the system speech engine, then return to the app to refresh the list. After changing engines, stop and start listening. If a saved voice is removed or belongs to another engine, the app falls back to automatic selection until that voice is available again or you choose another.

The listener, WebSocket and Android TextToSpeech engine run in a native foreground service, independent of the React screen / JS runtime. A bounded, periodically renewed partial wake lock and the requested battery exemption allow network processing with the screen off. Android's `specialUse` foreground service type describes the continuous user-started spoken notification listener and avoids data-sync service time limits. This is a personally distributed APK, not a Play Store submission.

Android can still stop apps: force-stop, the system's Stop control, reboot, or aggressive manufacturer battery policies require reopening and starting again. Set Tailscale to unrestricted battery use as well if its VPN sleeps. No boot auto-start is installed. Listening consumes more battery than push notifications. Speech follows media volume/output (including Bluetooth); muted media waits until unmuted or expiry. A local offline TTS voice is preferred; install one in Voice settings if needed. Do Not Disturb/device policies may still suppress audio.

Kokoro runs on nixpi without a third-party speech API. The phone always receives the original message text, then requests authenticated WAV audio for that message and its selected voice. Generation is limited to 30 seconds on the server and 35 seconds including transfer on the phone; errors, busy responses, invalid audio or playback errors trigger Android fallback. Audio focus and playback completion still control delivery receipts. **Last playback** shows whether Kokoro or Android was used. Kokoro can work without an installed Android voice, but fallback then requires installing one. A message that expires before playback is not spoken. A failed primary playback can repeat a partially heard phrase through Android.

The initial Kokoro collection supports English. For other languages, turn off Kokoro and choose an appropriate Android voice. Kokoro requires the private server connection; Android fallback works locally for messages already received by the phone. It cannot receive new server messages without a network connection.

## Develop and build locally

Node 22.13+ (Node 24 LTS recommended), npm, JDK 17, Android SDK 36 and build-tools 36.0.0.

```sh
npm ci
npm test
npm run format:check
npm run typecheck
npm exec --workspace @audio-notifications/mobile -- eslint .
npm run build:apk
```

`build:apk` prebuilds Android through Expo, signs a standalone release APK with the JS bundle included, and writes `artifacts/audio-notifications-<app-version>.apk`. No Metro/EAS connection is needed. ARM64 and ARMv7 are included; override `AUDIO_ABIS` for other architectures. The release signing key and password are generated once under `~/.config/audio-notifications/` and never committed. Back them up to keep installing upgrades over the same app. Increase Android `versionCode` and app version for subsequent releases. Use `AUDIO_SIGNING_DIR`, `JAVA_HOME`, and `ANDROID_HOME` to override local paths (Linux requires JAVA_HOME and ANDROID_HOME).

Custom native code lives in `apps/mobile/modules/audio-listener`; generated `android/` and `ios/` are ignored. This app requires a native build, not Expo Go. Credentials are encrypted with Android Keystore; Android backup is disabled. The APK contains only the tailnet server URL, no server/phone tokens.

## Server and deployment

The server uses `src/server.js` to wire together focused modules: `http/` handles
JSON requests and routing, `services/` owns pairing and message operations,
`realtime/` manages WebSocket delivery and acknowledgements, `storage/` owns the
SQLite schema and transactions, and `lib/` contains authentication, errors, and
rate limiting. `src/index.js` remains the process entry point.

Run `npm run format` to format the server source, tests, and package configuration
with Prettier, or `npm run format:check` to check formatting without changing files.

```sh
cp .env.example .env
# Set API_TOKEN to a cryptographically random secret of at least 32 characters.
docker compose up -d --build
sudo tailscale serve --bg --https=8444 http://127.0.0.1:8787
```

Deployed checkout: `infiniter@nixpi.tail6650cb.ts.net:~/services/audio-notifications`. Docker binds localhost only; Tailscale Serve provides HTTPS/WSS privately on port 8444. It coexists with the existing service on 8443. SQLite lives in the `audio-data` Docker volume; preserve this volume on upgrades. The container restarts unless stopped and has a health check. Use `docker compose logs --tail=100 server` and `docker compose ps` for diagnostics. Back up SQLite using its online backup API or stop the container before copying the database and WAL files.

The producer/admin bearer token is in the deployment's `.env`. Agent config on each authorized host is `~/.config/audio-notifications/client.json` with mode 600:

```json
{"url":"https://nixpi.tail6650cb.ts.net:8444","token":"YOUR_API_TOKEN"}
```

Install the skill directory into `~/.codex/skills/audio-notify`. Its `scripts/notify.py` helper can create a pairing code, list devices, send a message, and wait for spoken receipts. Device tokens cannot send messages or administer the service. Pair codes are single use, valid seven days, and rate limited. Only credential hashes are stored in SQLite. Never put producer credentials in an APK or public relay upload.

The `kokoro` container has no published port. Its model assets are checksum-verified during image build, and the service is limited to two CPUs, 1.2 GB RAM and one synthesis job at a time. The server shares duplicate requests and caches up to 32 MB of audio in memory for two minutes. Credentials and notification text are not written to speech logs. Model warm-up or failure never prevents the notification server from starting. Leave `KOKORO_URL` unset when running Node alone to retain Android-only operation.

Run worker tests after building its image:

```sh
docker build -f apps/kokoro/Dockerfile -t audio-kokoro:test .
docker run --rm -e PYTHONPATH=/app -v "$PWD/apps/kokoro/test_worker.py:/tests/test_worker.py:ro" audio-kokoro:test python -m unittest discover -s /tests
```

Model/runtime sources: [Kokoro model and voices](https://huggingface.co/hexgrad/Kokoro-82M), [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx). The model weights are Apache 2.0; the wrapper is MIT. Runtime dependencies retain their respective licenses.

## REST contract

Producer/admin routes require the producer bearer token. `/v1/pair` is unauthenticated; `/v1/listen`, `/v1/voices` and `/v1/speech` require a paired device bearer token.

| Method | Route | Body / result |
|---|---|---|
| GET | `/health` | Unauthenticated liveness |
| POST | `/v1/pairing` | `{}` → single-use code |
| POST | `/v1/pair` | `{code,name}` → deviceId + device token |
| GET | `/v1/devices` | Paired devices and active connection flags |
| DELETE | `/v1/devices/:id` | Revoke device and disconnect it |
| POST | `/v1/messages` | `{text,ttlSeconds?,deviceId?}` → 202 + id and per-device receipts |
| GET | `/v1/messages/:id` | Message and per-device delivery statuses |
| WS | `/v1/listen` | One queued message at a time; phone acknowledges TTS completion |
| GET | `/v1/voices` | Kokoro availability and voice choices (device credential) |
| POST | `/v1/speech` | `{messageId,voice?}` → WAV for that device’s unexpired queued message; `{preview:true,voice?}` speaks a fixed preview sentence |

Text is 1–2000 characters. Default TTL is 300 seconds; range 1–86400. Without deviceId, sends to all currently paired devices (409 if none). Newly paired devices do not receive previous broadcasts. `Idempotency-Key` prevents duplicate POSTs, with 409 for a reused key with different payload. Receipts and keys are retained seven days after expiry. Offline queues survive restarts; unexpired messages replay on reconnect. Delivery states are `queued`, `spoken`, `failed`, `expired`. Queued means accepted, not heard.

The phone durably remembers its last 200 acknowledgements to avoid replay after a connection drop. Delivery is at least once: a process crash after speech but before persisting the receipt, an audio-focus interruption, or receipt eviction can cause a repeated phrase. Expiry is checked before speech starts, so an already-speaking message may finish after expiry. TTS completion does not prove the user heard the message.

## Validation

Server integration tests cover auth, one-time pairing, separate producer/device permissions, validation, ordered delivery, idempotency conflicts, acknowledgement, reconnect replay, expiry, targeting, revocation, and SQLite persistence. For real phone acceptance, test a REST send while locked, while another app is focused, after a network interruption, and after 15+ minutes idle. Manufacturer-specific battery behavior must be checked on the actual phone.

Implementation references: [Expo local modules](https://docs.expo.dev/modules/get-started/), [Android foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types), [Android Doze exemptions](https://developer.android.com/training/monitoring-device-state/doze-standby).

### Verified release (2026-09-23)

The signed ARM64/ARMv7 release APK was installed and exercised on an Android 16 (API 36) ARM64 emulator using an offline eSpeak NG engine. Pairing, notification permission, battery exemption, foreground speech, screen-off speech (`mWakefulness=Asleep`), forced Doze (`mState=IDLE`), and recovery of queued messages after loss of all network connectivity passed with actual TTS completion receipts from the native service. The app did not need to be reopened for reconnect delivery. This does not substitute for a long-idle test on the user's physical phone/OEM firmware.

Five server integration tests, TypeScript, ESLint, 20 Expo Doctor checks, release APK signature verification, and the deployed HTTPS/WSS protocol smoke test passed. Release APK SHA-256: `7e7d7e472c071487a2738ed89b83ddf51720422ec2714c3273d0746d67a6c18a`.

### Voice picker update (2026-09-23)

The updated signed release passed TypeScript, ESLint, native compilation and APK signature verification. An Android 16 ARM64 emulator with eSpeak detected 133 available voices. Manual checks covered the missing-engine error, search, selection, persistence after force-stop/relaunch, changing voices while listening, preview completion, and a missing saved voice falling back to automatic speech. These speech checks used local previews without pairing the emulator to the notification server. APK SHA-256: `4d1deb3e166cb247c60ff9e1d77c6b6bc75ad2a9b1ebb082bc2406844b5edce8`.
