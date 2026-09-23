---
name: audio-notify
description: Send a short spoken notification to Viktor's paired Android phone through the private nixpi audio notification server. Use when asked to notify Viktor aloud or when he explicitly requests a spoken completion update.
---

# Audio Notify

Send only the notification the user requested. It will be spoken aloud on every paired phone unless a device is selected. Prefer one or two short sentences; omit credentials and unnecessarily sensitive content.

The server is `https://nixpi.tail6650cb.ts.net:8444` (Tailscale required). The phone must be paired, listening, and reachable. Agent credentials live in `~/.config/audio-notifications/client.json` on the Mac and nixpi; never print them or embed them in source/APKs.

Use the bundled helper (Python 3, standard library only):

```sh
python3 scripts/notify.py send 'The build is finished and the tests passed.' --wait 30
python3 scripts/notify.py devices
python3 scripts/notify.py status MESSAGE_ID
```

Resolve `scripts/notify.py` relative to this skill folder. `send` accepts `--device DEVICE_ID`, `--ttl 300`, and `--key UNIQUE_REQUEST_ID`. It generates an idempotency key if omitted and prints it before sending. Reuse that key and the same payload after an uncertain timeout; do not blindly send a new request that might speak twice. Keys/receipts are retained seven days after message expiry.

`202` means queued, not spoken. Report spoken only when the delivery status is `spoken`; `failed`, `expired`, and a still-queued message are distinct results. A spoken receipt means Android's TTS engine finished, not proof that the person heard it. The helper exits 0 only for successful API operations (or, with `--wait`, when every recipient reports spoken); it exits 2 if delivery failed, expired, or remains queued after the wait. An offline phone receives queued messages upon reconnection until their TTL expires (default five minutes).

REST equivalent:

- `POST /v1/messages`, `Authorization: Bearer API_TOKEN`, `Content-Type: application/json`, `Idempotency-Key: unique-key`.
- JSON: `{"text":"Your message","ttlSeconds":300}`; optional `deviceId` targets one paired device.
- `GET /v1/messages/:id` returns per-device receipts.
- `GET /v1/devices` lists paired devices and connection state.

For pairing, run `python3 scripts/notify.py pair-code`. It creates a one-use code valid seven days; give that code to the user to enter on the app's single screen. Pairing a replacement installation creates a new device; remove obsolete devices only when requested with authenticated `DELETE /v1/devices/:id`.
