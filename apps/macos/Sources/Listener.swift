import Combine
import Foundation

@MainActor final class Listener: ObservableObject {
    static let defaultURL = "https://nixpi.tail6650cb.ts.net:8444"
    @Published private(set) var credentials: Credentials?
    @Published private(set) var connection = "Not paired"
    @Published private(set) var activity = ""
    @Published private(set) var lastText = ""
    @Published private(set) var lastPlayback = ""
    @Published private(set) var listening = false
    @Published private(set) var pairing = false
    @Published var error = ""
    @Published var useKokoro: Bool {
        didSet { defaults.set(useKokoro, forKey: "useKokoro") }
    }

    private let defaults: UserDefaults
    private let api = API()
    private let output: SpeechOutput
    private let receiptDirectory: URL?
    private var receipts: ReceiptStore?
    private var socket: URLSessionWebSocketTask?
    private var networkTask: Task<Void, Never>?
    private var playbackTask: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var active: IncomingMessage?

    init(credentials: Credentials? = nil, output: SpeechOutput? = nil,
         receiptDirectory: URL? = nil, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.output = output ?? SpeechPlayer()
        self.receiptDirectory = receiptDirectory
        useKokoro = defaults.object(forKey: "useKokoro") as? Bool ?? true
        if let credentials {
            do { try configure(credentials) } catch { self.error = error.localizedDescription }
        }
    }

    func configure(_ credentials: Credentials) throws {
        _ = try API.serverURL(credentials.url)
        let store = try ReceiptStore(deviceId: credentials.deviceId, directory: receiptDirectory)
        stop()
        receipts = store
        self.credentials = credentials
        connection = "Ready"
    }

    func pair(url: String, code: String) async {
        guard !pairing else { return }
        pairing = true
        error = ""
        defer { pairing = false }
        do {
            let credentials = try await api.pair(url: url, code: code,
                                                name: String((Host.current().localizedName ?? "Mac").prefix(80)))
            try CredentialStore.save(credentials)
            try configure(credentials)
            start()
        } catch { self.error = error.localizedDescription }
    }

    func start() {
        guard credentials != nil, !listening else { return }
        listening = true
        error = ""
        networkTask = Task { await connectLoop() }
    }

    func stop() {
        listening = false
        networkTask?.cancel()
        networkTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        cancelPlayback()
        connection = credentials == nil ? "Not paired" : "Paused"
    }

    private func connectLoop() async {
        var retry: Double = 1
        while !Task.isCancelled, listening, let credentials {
            var current: URLSessionWebSocketTask?
            var heartbeat: Task<Void, Never>?
            do {
                connection = "Connecting…"
                var components = URLComponents(url: try API.serverURL(credentials.url), resolvingAgainstBaseURL: false)!
                components.scheme = components.scheme == "https" ? "wss" : "ws"
                components.path = "/v1/listen"
                var request = URLRequest(url: components.url!)
                request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
                request.timeoutInterval = 15
                let ws = api.session.webSocketTask(with: request)
                ws.maximumMessageSize = 16 * 1024
                current = ws
                socket = ws
                ws.resume()
                heartbeat = Task {
                    while !Task.isCancelled {
                        do {
                            try await Task.sleep(nanoseconds: 20_000_000_000)
                            try Task.checkCancellation()
                            try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
                                ws.sendPing { error in
                                    if let error { done.resume(throwing: error) } else { done.resume() }
                                }
                            }
                        } catch {
                            if !Task.isCancelled { ws.cancel(with: .goingAway, reason: nil) }
                            return
                        }
                    }
                }
                while !Task.isCancelled {
                    let frame = try await ws.receive()
                    guard socket === ws, listening else { break }
                    let data: Data
                    switch frame {
                    case .string(let text): data = Data(text.utf8)
                    case .data(let bytes): data = bytes
                    @unknown default: continue
                    }
                    struct Envelope: Decodable { let type: String }
                    let envelope = try JSONDecoder().decode(Envelope.self, from: data)
                    if envelope.type == "ready" {
                        connection = "Listening"
                        retry = 1
                    } else if envelope.type == "message" {
                        let message = try JSONDecoder().decode(IncomingMessage.self, from: data)
                        guard !message.id.isEmpty, !message.text.isEmpty, message.text.count <= 2000,
                              message.expiresAt.isFinite else { throw ClientError.message("Invalid server message.") }
                        try await receive(message, socket: ws)
                    }
                }
            } catch {
                guard !Task.isCancelled, listening, socket === current else {
                    heartbeat?.cancel()
                    return
                }
                let code = current?.closeCode.rawValue
                let httpStatus = (current?.response as? HTTPURLResponse)?.statusCode
                if httpStatus == 401 || code == 4001 || code == 4000 {
                    listening = false
                    connection = code == 4000 ? "Connected elsewhere" : "Pair again"
                    self.error = code == 4000 ? "Another listener replaced this connection. Quit it before resuming." : "Device pairing was revoked. Enter a new pairing code."
                } else {
                    connection = "Reconnecting — check Tailscale"
                }
            }
            heartbeat?.cancel()
            current?.cancel(with: .goingAway, reason: nil)
            if socket === current { socket = nil }
            guard listening, !Task.isCancelled else { return }
            do { try await Task.sleep(nanoseconds: UInt64(retry * 1_000_000_000)) } catch { return }
            retry = min(retry * 2, 30)
        }
    }

    private func receive(_ message: IncomingMessage, socket: URLSessionWebSocketTask) async throws {
        if let saved = receipts?.get(message.id) {
            try await send(saved, socket: socket)
            return
        }
        if active?.id == message.id { return }
        guard active == nil else { throw ClientError.message("Server sent overlapping messages.") }
        active = message
        lastText = message.text
        watchdog = Task {
            do { try await Task.sleep(nanoseconds: 150_000_000_000) } catch { return }
            guard active?.id == message.id else { return }
            output.stop()
            playbackTask?.cancel()
            await complete(message, status: "failed", error: "Speech timed out.")
        }
        playbackTask = Task {
            do {
                guard !message.expired else { await complete(message, status: "expired"); return }
                var played = false
                if useKokoro, let credentials {
                    activity = "Preparing Kokoro…"
                    do {
                        let audio = try await api.audio(message, credentials: credentials)
                        try Task.checkCancellation()
                        guard !message.expired else { await complete(message, status: "expired"); return }
                        activity = "Speaking · Kokoro"
                        try await output.playAudio(audio)
                        lastPlayback = "Kokoro · Heart"
                        played = true
                    } catch {
                        try Task.checkCancellation()
                    }
                }
                if !played {
                    try Task.checkCancellation()
                    guard !message.expired else { await complete(message, status: "expired"); return }
                    activity = "Speaking · macOS"
                    try await output.speak(message.text)
                    lastPlayback = useKokoro ? "macOS fallback" : "macOS"
                }
                try Task.checkCancellation()
                await complete(message, status: "spoken")
            } catch is CancellationError {
                // Quit/pause leaves the server delivery queued for the next launch.
            } catch {
                await complete(message, status: "failed", error: "macOS speech failed.")
            }
        }
    }

    private func complete(_ message: IncomingMessage, status: String, error: String? = nil) async {
        guard active?.id == message.id else { return }
        let receipt = Receipt(id: message.id, status: status, error: error)
        do {
            // Persist before sending so reconnect/relaunch can acknowledge without repeating speech.
            try receipts?.save(receipt)
        } catch {
            self.error = "Could not save delivery receipt. Check available disk space."
            stop()
            return
        }
        active = nil
        activity = ""
        watchdog?.cancel()
        watchdog = nil
        if status == "failed" { self.error = error ?? "Speech failed." }
        if let ws = socket {
            do { try await send(receipt, socket: ws) }
            catch { ws.cancel(with: .goingAway, reason: nil) }
        }
    }

    private func send(_ receipt: Receipt, socket: URLSessionWebSocketTask) async throws {
        let data = try JSONEncoder().encode(receipt)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }

    private func cancelPlayback() {
        playbackTask?.cancel()
        playbackTask = nil
        watchdog?.cancel()
        watchdog = nil
        active = nil
        output.stop()
        activity = ""
    }
}
