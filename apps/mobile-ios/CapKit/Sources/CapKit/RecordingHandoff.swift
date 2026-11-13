import Foundation
import Security

public enum RecordingHandoff {
    /// How the recording left the extension. Cap only hears about an upload it finishes itself, so the other two
    /// endings have to be told to it.
    public enum Outcome: String, Codable, Sendable {
        case uploaded
        case handedOver
        case failed
    }

    public struct Entry: Codable, Sendable, Equatable {
        public let capId: String
        public let shareUrl: String
        public let createdAt: Date
        public let outcome: Outcome?
        public let durationSeconds: Double?

        public init(capId: String, shareUrl: String, createdAt: Date = .now, outcome: Outcome? = nil, durationSeconds: Double? = nil) {
            self.capId = capId
            self.shareUrl = shareUrl
            self.createdAt = createdAt
            self.outcome = outcome
            self.durationSeconds = durationSeconds
        }
    }

    private static let service = "so.cap.mobile.handoff"
    private static let account = "screen-recording"

    private static func query(_ accessGroup: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    public static func save(_ entry: Entry, accessGroup: String? = nil) {
        guard let data = try? JSONEncoder().encode(entry) else { return }
        let base = query(accessGroup)
        SecItemDelete(base as CFDictionary)
        var attributes = base
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(attributes as CFDictionary, nil)
    }

    public static func take(accessGroup: String? = nil, maxAge: TimeInterval = 30 * 60, now: Date = .now) -> Entry? {
        var lookup = query(accessGroup)
        lookup[kSecReturnData as String] = kCFBooleanTrue
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        SecItemDelete(query(accessGroup) as CFDictionary)
        guard let entry = try? JSONDecoder().decode(Entry.self, from: data),
              CapID(entry.capId) != nil,
              now.timeIntervalSince(entry.createdAt) < maxAge
        else { return nil }
        return entry
    }
}
