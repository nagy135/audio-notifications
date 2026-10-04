import Foundation

@MainActor private final class FakeSpeech: SpeechOutput {
    var spoken: [String] = []
    var audioCount = 0
    var hold = false
    var failAudio = false
    var failSpeech = false
    var pending: CheckedContinuation<Void, Error>?

    func playAudio(_ data: Data) async throws {
        audioCount += 1
        if failAudio { throw ClientError.message("Simulated playback error") }
        try await waitIfHeld()
    }
    func speak(_ text: String) async throws {
        spoken.append(text)
        if failSpeech { throw ClientError.message("Simulated speech error") }
        try await waitIfHeld()
    }
    private func waitIfHeld() async throws {
        if hold { try await withCheckedThrowingContinuation { pending = $0 } }
    }
    func release() { let done = pending; pending = nil; done?.resume() }
    func stop() { let done = pending; pending = nil; done?.resume(throwing: CancellationError()) }
}

@main struct Integration {
    @MainActor static func main() async throws {
        let config = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: String]
        let url = config["url"]!
        let token = config["token"]!
        let root = URL(fileURLWithPath: CommandLine.arguments[2])
        func post(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
            var request = URLRequest(url: URL(string: url + path)!)
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as! HTTPURLResponse).statusCode < 300 else { throw ClientError.message("Test HTTP failure") }
            return try JSONSerialization.jsonObject(with: data) as! [String: Any]
        }
        func status(_ id: String) async throws -> String {
            var request = URLRequest(url: URL(string: url + "/v1/messages/" + id)!)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let (data, _) = try await URLSession.shared.data(for: request)
            let result = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            return (result["deliveries"] as! [[String: Any]])[0]["status"] as! String
        }
        func wait(_ label: String, _ condition: () async throws -> Bool) async throws {
            let deadline = Date().addingTimeInterval(12)
            while !(try await condition()) {
                if Date() > deadline { throw ClientError.message("Timed out: \(label)") }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        let code = try await post("/v1/pairing", [:])["code"] as! String
        let credentials = try await API().pair(url: url, code: code, name: "Mac integration test")
        let settings = UserDefaults(suiteName: "audio-macos-tests-\(UUID().uuidString)")!
        let speech = FakeSpeech()
        var listener = Listener(credentials: credentials, output: speech, receiptDirectory: root, defaults: settings)
        listener.start()
        try await wait("initial connection") { listener.connection == "Listening" }
        func send(_ text: String, ttl: Int = 60) async throws -> String {
            try await post("/v1/messages", ["text": text, "deviceId": credentials.deviceId, "ttlSeconds": ttl])["id"] as! String
        }

        let fallback = try await send("Fallback speech")
        try await wait("fallback receipt") { try await status(fallback) == "spoken" }
        assert(speech.spoken == ["Fallback speech"] && speech.audioCount == 0)
        print("PASS: pairing, authenticated WebSocket, Kokoro failure → macOS completion receipt")

        _ = try await post("/test/mode", ["mode": "valid"])
        let kokoro = try await send("Kokoro speech")
        try await wait("Kokoro receipt") { try await status(kokoro) == "spoken" }
        assert(speech.audioCount == 1 && speech.spoken.count == 1)
        speech.failAudio = true
        let decodeFailure = try await send("Playback fallback")
        try await wait("playback fallback") { try await status(decodeFailure) == "spoken" }
        assert(speech.spoken.last == "Playback fallback")
        speech.failAudio = false
        _ = try await post("/test/mode", ["mode": "invalid"])
        let invalid = try await send("Invalid audio fallback")
        try await wait("invalid WAV fallback") { try await status(invalid) == "spoken" }
        assert(speech.spoken.last == "Invalid audio fallback")
        print("PASS: Kokoro WAV playback, invalid audio and playback-error fallback")

        listener.useKokoro = false
        speech.hold = true
        let interrupted = try await send("Keep playing during reconnect")
        try await wait("speech started") { speech.pending != nil }
        let statusDuringPlayback = try await status(interrupted)
        assert(statusDuringPlayback == "queued")
        let countBeforeDrop = speech.spoken.count
        _ = try await post("/test/drop", [:])
        try await wait("network disconnect") { listener.connection != "Listening" }
        try await wait("automatic reconnect") { listener.connection == "Listening" }
        assert(speech.spoken.count == countBeforeDrop)
        speech.release()
        try await wait("receipt after reconnect") { try await status(interrupted) == "spoken" }
        print("PASS: no early acknowledgement; reconnect during playback does not repeat speech")

        let paused = try await send("Replay after pause")
        try await wait("speech before pause") { speech.pending != nil }
        listener.stop()
        let statusAfterPause = try await status(paused)
        assert(statusAfterPause == "queued")
        speech.hold = false
        listener.start()
        try await wait("replay after resume") { try await status(paused) == "spoken" }
        print("PASS: pause cancels playback and retains queued delivery for resume")

        listener.stop()
        _ = try await post("/test/requeue", ["id": paused, "deviceId": credentials.deviceId])
        let speechAfterRelaunch = FakeSpeech()
        listener = Listener(credentials: credentials, output: speechAfterRelaunch, receiptDirectory: root, defaults: settings)
        listener.start()
        try await wait("durable receipt replay") { try await status(paused) == "spoken" }
        assert(speechAfterRelaunch.spoken.isEmpty && speechAfterRelaunch.audioCount == 0)
        print("PASS: persisted receipts suppress repeated playback after relaunch")

        _ = try await post("/test/clock", ["offset": -10000])
        let expired = try await send("Expired at the client", ttl: 1)
        try await wait("expiry receipt") { try await status(expired) == "expired" }
        assert(speechAfterRelaunch.spoken.isEmpty)
        _ = try await post("/test/clock", ["offset": 0])
        speechAfterRelaunch.failSpeech = true
        let failed = try await send("Fail macOS speech")
        try await wait("failed receipt") { try await status(failed) == "failed" }
        print("PASS: expired messages are skipped; speech failures produce failed receipts")

        let store = try ReceiptStore(deviceId: UUID().uuidString, directory: root)
        for index in 0..<205 { try store.save(Receipt(id: "\(index)", status: "spoken", error: nil)) }
        assert(store.get("0") == nil && store.get("204") != nil)
        for invalidURL in ["http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com?token=secret"] {
            do { _ = try API.serverURL(invalidURL); fatalError("Accepted invalid URL") } catch {}
        }
        print("PASS: receipt retention and server URL validation")
        listener.stop()
        print("All macOS integration checks passed.")
    }
}
