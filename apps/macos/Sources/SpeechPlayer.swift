import AVFoundation
import Foundation

@MainActor protocol SpeechOutput: AnyObject {
    func playAudio(_ data: Data) async throws
    func speak(_ text: String) async throws
    func stop()
}

@MainActor final class SpeechPlayer: NSObject, SpeechOutput, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var utterance: AVSpeechUtterance?
    private var player: AVAudioPlayer?
    private var continuation: CheckedContinuation<Void, Error>?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func playAudio(_ data: Data) async throws {
        try Task.checkCancellation()
        let audio = try AVAudioPlayer(data: data)
        player = audio
        audio.delegate = self
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            if !audio.prepareToPlay() || !audio.play() {
                finish(.failure(ClientError.message("Could not play Kokoro audio.")))
            }
        }
    }

    func speak(_ text: String) async throws {
        try Task.checkCancellation()
        let speech = AVSpeechUtterance(string: text)
        speech.voice = AVSpeechSynthesisVoice(language: "en-US")
        guard speech.voice != nil else { throw ClientError.message("Install an English voice in macOS Accessibility → Read & Speak.") }
        utterance = speech
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            synthesizer.speak(speech)
        }
    }

    func stop() {
        let oldPlayer = player
        player = nil
        utterance = nil
        oldPlayer?.stop()
        synthesizer.stopSpeaking(at: .immediate)
        finish(.failure(CancellationError()))
    }

    private func finish(_ result: Result<Void, Error>) {
        let pending = continuation
        continuation = nil
        player = nil
        utterance = nil
        pending?.resume(with: result)
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            guard self.player === player else { return }
            self.finish(flag ? .success(()) : .failure(ClientError.message("Kokoro playback failed.")))
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            guard self.player === player else { return }
            self.finish(.failure(ClientError.message("Kokoro audio could not be decoded.")))
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            guard self.utterance === utterance else { return }
            self.finish(.success(()))
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in
            guard self.utterance === utterance else { return }
            self.finish(.failure(ClientError.message("macOS speech was interrupted.")))
        }
    }
}
