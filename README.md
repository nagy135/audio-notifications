# Audio Notifications

An Expo / React Native single-screen Android app and a persistent Node.js notification server. Agents POST text; the phone reads it aloud, including while the screen is locked.

- `apps/mobile`: Expo SDK 55, React Native 0.83, a local Kotlin Expo module.
- `apps/server`: REST + WebSocket server, SQLite queue and delivery receipts.
- `skills/audio-notify`: agent skill and Python REST client.
- `compose.yaml`: private Docker deployment on nixpi.

## Install and listen

1. Install the signed APK and connect Tailscale on the phone.
2. Enter the one-use pairing code. The prefilled server is `https://nixpi.tail6650cb.ts.net:8444`.
3. Allow notifications and background listening (battery optimization exemption), then tap **Start listening**.
4. Tap **Test voice**, set media volume, then lock the phone. The persistent notification includes a Stop action.

The listener, WebSocket and Android TextToSpeech engine run in a native foreground service, independent of the React screen / JS runtime. A bounded, periodically renewed partial wake lock and the requested battery exemption allow network processing with the screen off. Android's `specialUse` foreground service type describes the continuous user-started spoken notification listener and avoids data-sync service time limits. This is a personally distributed APK, not a Play Store submission.

Android can still stop apps: force-stop, the system's Stop control, reboot, or aggressive manufacturer battery policies require reopening and starting again. Set Tailscale to unrestricted battery use as well if its VPN sleeps. No boot auto-start is installed. Listening consumes more battery than push notifications. Speech follows media volume/output (including Bluetooth); muted media waits until unmuted or expiry. A local offline TTS voice is preferred; install one in Voice settings if needed. Do Not Disturb/device policies may still suppress audio.

## Develop and build locally

Node 22.13+ (Node 24 LTS recommended), npm, JDK 17, Android SDK 36 and build-tools 36.0.0.

```sh
npm ci
npm test
npm run typecheck
npm exec --workspace @audio-notifications/mobile -- eslint .
npm run build:apk
```

`build:apk` prebuilds Android through Expo, signs a standalone release APK with the JS bundle included, and writes `artifacts/audio-notifications-1.0.0.apk`. No Metro/EAS connection is needed. ARM64 and ARMv7 are included; override `AUDIO_ABIS` for other architectures. The release signing key and password are generated once under `~/.config/audio-notifications/` and never committed. Back them up to keep installing upgrades over the same app. Increase Android `versionCode` and app version for subsequent releases. Use `AUDIO_SIGNING_DIR`, `JAVA_HOME`, and `ANDROID_HOME` to override local paths (Linux requires JAVA_HOME and ANDROID_HOME).

Custom native code lives in `apps/mobile/modules/audio-listener`; generated `android/` and `ios/` are ignored. This app requires a native build, not Expo Go. Credentials are encrypted with Android Keystore; Android backup is disabled. The APK contains only the tailnet server URL, no server/phone tokens.

## Server and deployment

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

## REST contract

All `/v1/*` routes except `/v1/pair` require the producer bearer token; `/v1/listen` takes a paired device bearer token.

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

Text is 1–2000 characters. Default TTL is 300 seconds; range 1–86400. Without deviceId, sends to all currently paired devices (409 if none). Newly paired devices do not receive previous broadcasts. `Idempotency-Key` prevents duplicate POSTs, with 409 for a reused key with different payload. Receipts and keys are retained seven days after expiry. Offline queues survive restarts; unexpired messages replay on reconnect. Delivery states are `queued`, `spoken`, `failed`, `expired`. Queued means accepted, not heard.

The phone durably remembers its last 200 acknowledgements to avoid replay after a connection drop. Delivery is at least once: a process crash after speech but before persisting the receipt, an audio-focus interruption, or receipt eviction can cause a repeated phrase. Expiry is checked before speech starts, so an already-speaking message may finish after expiry. TTS completion does not prove the user heard the message.

## Validation

Server integration tests cover auth, one-time pairing, separate producer/device permissions, validation, ordered delivery, idempotency conflicts, acknowledgement, reconnect replay, expiry, targeting, revocation, and SQLite persistence. For real phone acceptance, test a REST send while locked, while another app is focused, after a network interruption, and after 15+ minutes idle. Manufacturer-specific battery behavior must be checked on the actual phone.

Implementation references: [Expo local modules](https://docs.expo.dev/modules/get-started/), [Android foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types), [Android Doze exemptions](https://developer.android.com/training/monitoring-device-state/doze-standby).
