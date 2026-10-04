import Foundation

// Bearer credentials must not follow HTTP redirects to another endpoint.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class API {
    let session: URLSession

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 35
        config.timeoutIntervalForResource = 35
        session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }

    static func serverURL(_ value: String) throws -> URL {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(host))
        else { throw ClientError.message("Enter an HTTPS server URL (HTTP is allowed for localhost).") }
        return url
    }

    func request(url: URL, path: String, token: String? = nil, body: [String: String]) -> URLRequest {
        var request = URLRequest(url: url.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try? JSONEncoder().encode(body)
        return request
    }

    func pair(url: String, code: String, name: String) async throws -> Credentials {
        let base = try Self.serverURL(url)
        let request = request(url: base, path: "v1/pair", body: ["code": code, "name": name])
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 201 else {
            throw ClientError.message("Pairing failed. Check the code, server URL, and Tailscale connection.")
        }
        struct Pair: Decodable { let deviceId: String; let token: String }
        let paired = try JSONDecoder().decode(Pair.self, from: data)
        return Credentials(url: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
                           deviceId: paired.deviceId, token: paired.token)
    }

    func audio(_ message: IncomingMessage, credentials: Credentials) async throws -> Data {
        var request = request(url: try Self.serverURL(credentials.url), path: "v1/speech",
                              token: credentials.token, body: ["messageId": message.id, "voice": "af_heart"])
        request.timeoutInterval = min(35, max(0.1, message.expiresAt / 1000 - Date().timeIntervalSince1970))
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("audio/wav") == true,
              data.count >= 44, data.count <= 8 * 1024 * 1024,
              String(data: data.prefix(4), encoding: .ascii) == "RIFF",
              String(data: data[8..<12], encoding: .ascii) == "WAVE"
        else { throw ClientError.message("Kokoro audio unavailable.") }
        return data
    }
}

struct IncomingMessage: Decodable {
    let type: String
    let id: String
    let text: String
    let expiresAt: Double
    var expired: Bool { expiresAt <= Date().timeIntervalSince1970 * 1000 }
}
