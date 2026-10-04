import Foundation
import Security

struct Credentials: Codable {
    let url: String
    let deviceId: String
    let token: String
}

struct Receipt: Codable {
    let type = "ack"
    enum CodingKeys: String, CodingKey { case type, id, status, error }
    let id: String
    let status: String
    let error: String?
}

enum ClientError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case .message(let message) = self { return message }
        return nil
    }
}

enum CredentialStore {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "local.audio-notifications.macos",
        kSecAttrAccount as String: "paired-device"
    ]

    static func load() throws -> Credentials? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw ClientError.message("Could not read pairing from Keychain (\(status)).")
        }
        return try JSONDecoder().decode(Credentials.self, from: data)
    }

    static func save(_ credentials: Credentials) throws {
        let data = try JSONEncoder().encode(credentials)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw ClientError.message("Could not save pairing in Keychain (\(status)).")
        }
    }
}

final class ReceiptStore {
    private let file: URL
    private var receipts: [Receipt]

    init(deviceId: String, directory: URL? = nil) throws {
        let root = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Audio Notifications", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        // IDs come from the server; do not allow them to create paths outside our directory.
        guard UUID(uuidString: deviceId) != nil else { throw ClientError.message("Invalid device ID.") }
        file = root.appendingPathComponent("receipts-\(deviceId).json")
        if FileManager.default.fileExists(atPath: file.path) {
            receipts = try JSONDecoder().decode([Receipt].self, from: Data(contentsOf: file))
        } else {
            receipts = []
        }
    }

    func get(_ id: String) -> Receipt? { receipts.first { $0.id == id } }

    func save(_ receipt: Receipt) throws {
        var next = receipts.filter { $0.id != receipt.id }
        next.append(receipt)
        next = Array(next.suffix(200))
        try JSONEncoder().encode(next).write(to: file, options: .atomic)
        receipts = next
    }
}
