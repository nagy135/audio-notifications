# Audio Notifications for macOS

A native Swift app with a compact, standard macOS window. Opening a paired app starts listening to the existing
notification server's `/v1/listen` WebSocket. It plays Kokoro Heart audio and falls
back to macOS English speech when generation or playback fails.

## Build and open

Requires macOS 13+, Apple's Command Line Tools, and Tailscale for the private server.
No Xcode project, Swift packages, or Node runtime are needed to run the app.

From the repository root:

```sh
npm run build:macos
open "apps/macos/build/Audio Notifications.app"
```

On first launch, enter a one-use pairing code and click **Pair & listen**.
Generate the code with the existing `audio-notify` helper's `pair-code` command.
The prefilled server is `https://nixpi.tail6650cb.ts.net:8444`.

If this Mac already has `~/.config/audio-notifications/client.json`, you can pair
before opening the app:

```sh
python3 apps/macos/scripts/pair.py
open "apps/macos/build/Audio Notifications.app"
```

The helper uses the local producer configuration to obtain a one-use code.
The app receives only that code, exchanges it for its own device token, and saves
the pairing in Keychain. Secrets stay out of command-line arguments and build
artifacts. Run the helper with the app closed. Each pairing creates a new server
device; revoke an old Mac entry with the admin API if you intentionally pair again.

Drag the built app into Applications to install it. The build targets the current
Mac architecture and uses a local ad-hoc signature. Rebuilding or moving it may
cause macOS to request Keychain access again.

## Controls and behavior

- **Pause / Resume** stops or resumes the listener. Every launch starts listening.
- **Kokoro** enables the server voice; turn it off to use macOS speech directly.
- The gear opens pairing settings. **Done** returns to the status card.
- The title-bar close button, Dock Quit, or Command-Q stops playback and quits.
- The window uses normal stacking and can be minimized. It shows connection
  status, the latest message, playback engine, and errors.
- Network failures retry automatically with delays from one to thirty seconds.
  Wake from system sleep restarts the connection. Revocation or a replacement
  connection stops retries and displays an explanation.
- Each Mac has a separate pairing from the phone. Untargeted messages play on both;
  `deviceId` targets one device.
- A receipt is sent only after playback finishes. The last 200 receipts are saved
  atomically under `~/Library/Application Support/Audio Notifications/` to suppress
  replay after reconnect or relaunch. The app skips expired messages and bounds
  playback to 150 seconds. Pause/quit during playback leaves the message queued.

Audio follows the Mac's current output and volume. Completion does not prove that
you heard it. This app does not keep the Mac awake: system sleep suspends listening,
and unexpired messages resume after wake. A crash between speech and saving its
receipt, receipt eviction, or pausing partway through speech can repeat a phrase.
Kokoro playback failure can also repeat a partly heard phrase through macOS speech.
No login launch is installed. macOS speech needs an available English voice.

## Verify

```sh
npm run test:macos
```

Tests compile the actual Swift listener and run it against an isolated instance of
the existing server and a mock Kokoro worker. Controlled speech output verifies
completion receipts, fallback, reconnect during playback, pause/resume, persisted
duplicate suppression, expiry, speech errors, and receipt retention. Tests do not
play audio, access the real Keychain, or contact the deployed server. Verify actual
audio separately by sending a message targeted to the Mac device.
