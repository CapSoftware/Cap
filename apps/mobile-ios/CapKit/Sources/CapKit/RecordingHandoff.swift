import Foundation
import Security

public enum RecordingHandoff {
    public struct Entry: Codable, Sendable, Equatable {
        public let capId: String
        public let shareUrl: String
        public let createdAt: Date
        /// True when the extension finished the upload itself. Otherwise Cap finishes it and sees it complete.
        public let uploaded: Bool?
        public let durationSeconds: Double?

        public init(capId: String, shareUrl: String, createdAt: Date = .now, uploaded: Bool? = nil, durationSeconds: Double? = nil) {
            self.capId = capId
            self.shareUrl = shareUrl
            self.createdAt = createdAt
            self.uploaded = uploaded
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
