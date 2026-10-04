import AppKit
import SwiftUI

private struct ListenerCard: View {
    @ObservedObject var listener: Listener
    let showPairing: Bool
    let settings: () -> Void
    @State private var server = Listener.defaultURL
    @State private var code = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "speaker.wave.2.fill")
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(.teal)
                    .frame(width: 42, height: 42)
                    .background(.teal.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 4) {
                    Text("Audio Notifications").font(.system(size: 14, weight: .semibold))
                    Text(listener.activity.isEmpty ? listener.connection : listener.activity)
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button(action: settings) { Image(systemName: "gearshape") }
                    .help("Pair with the notification server")
            }
            .buttonStyle(.plain)

            if showPairing {
                Text("Connect Tailscale, then enter a one-use pairing code.")
                    .font(.caption).foregroundStyle(.secondary)
                TextField("Server URL", text: $server)
                SecureField("Pairing code", text: $code)
                    .onSubmit { pair() }
                HStack {
                    Button(listener.pairing ? "Pairing…" : "Pair & listen", action: pair)
                        .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || listener.pairing)
                    if listener.credentials != nil { Button("Done", action: settings) }
                }
                .onAppear { server = listener.credentials?.url ?? Listener.defaultURL }
            } else {
                Text(listener.lastText.isEmpty ? "Incoming messages will play aloud." : listener.lastText)
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .lineLimit(2).textSelection(.enabled)
                HStack {
                    Button(listener.listening ? "Pause" : "Resume") {
                        if listener.listening { listener.stop() } else { listener.start() }
                    }
                    Toggle("Kokoro", isOn: $listener.useKokoro).toggleStyle(.checkbox)
                        .help("Use Kokoro Heart with macOS speech as a fallback")
                    Spacer()
                    Text(listener.lastPlayback).font(.system(size: 10)).foregroundStyle(.secondary)
                }
                .font(.system(size: 12))
            }
            if !listener.error.isEmpty {
                Text(listener.error).font(.caption).foregroundStyle(.red).lineLimit(3)
            }
        }
        .padding(18)
        .frame(width: 380, height: showPairing ? 300 : 190, alignment: .topLeading)
        .background(.regularMaterial)
        .onChange(of: listener.credentials?.deviceId) { deviceId in
            if deviceId != nil, showPairing { settings() }
        }
    }

    private func pair() {
        let pairingCode = code
        code = ""
        Task { await listener.pair(url: server, code: pairingCode) }
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    private var listener: Listener!
    private var window: NSWindow!
    private var showPairing = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        listener = Listener()
        do {
            if let credentials = try CredentialStore.load() { try listener.configure(credentials) }
        } catch { listener.error = error.localizedDescription }
        showPairing = listener.credentials == nil
        installMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 190),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Audio Notifications"
        window.isReleasedWhenClosed = false
        refreshWindow()
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(wokeUp),
                                                          name: NSWorkspace.didWakeNotification, object: nil)
        listener.start()
    }

    private func refreshWindow() {
        let height: CGFloat = showPairing ? 300 : 190
        window.setContentSize(NSSize(width: 380, height: height))
        window.contentView = NSHostingView(rootView: ListenerCard(listener: listener, showPairing: showPairing) { [weak self] in
            guard let self else { return }
            self.showPairing = self.listener.credentials == nil || !self.showPairing
            self.refreshWindow()
        })
    }

    @objc private func wokeUp() {
        guard listener.listening else { return }
        listener.stop()
        listener.start()
    }

    private func installMenu() {
        let menu = NSMenu()
        let item = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Audio Notifications", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu
        menu.addItem(item)
        NSApp.mainMenu = menu
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) { listener.stop() }
}

@main struct AudioNotificationsApp {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--pair-stdin") {
            // Local provisioning helper: a one-use code arrives on stdin, never in argv.
            let data = FileHandle.standardInput.readDataToEndOfFile()
            Task {
                do {
                    struct PairInput: Decodable { let url: String; let code: String }
                    let input = try JSONDecoder().decode(PairInput.self, from: data)
                    let credentials = try await API().pair(url: input.url, code: input.code,
                        name: String((Host.current().localizedName ?? "Mac").prefix(80)))
                    try CredentialStore.save(credentials)
                    print("Paired Mac device: \(credentials.deviceId)")
                    exit(0)
                } catch {
                    FileHandle.standardError.write(Data("Pairing failed: \(error.localizedDescription)\n".utf8))
                    exit(1)
                }
            }
            RunLoop.main.run()
            return
        }
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}
