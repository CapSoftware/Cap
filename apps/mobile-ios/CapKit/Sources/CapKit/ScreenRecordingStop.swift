import Foundation
import notify
import Security

/// Lets Cap stop the screen recording, which runs in the broadcast extension's own process.
///
/// The request is written to the keychain group only Cap and its extensions can read, then a
/// system-wide notification wakes the extension. Any app can post that notification, so the
/// extension acts on it only when a fresh request is there too.
public enum ScreenRecordingStop {
    public static let notification = "so.cap.mobile.broadcast.stop"

    private static let service = "so.cap.mobile.handoff"
    private static let account = "stop-screen-recording"

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

    public static func request(accessGroup: String? = nil, now: Date = .now) {
        let base = query(accessGroup)
        SecItemDelete(base as CFDictionary)
        var attributes = base
        attributes[kSecValueData as String] = Data(String(now.timeIntervalSince1970).utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(attributes as CFDictionary, nil)
        notify_post(notification)
    }

    /// Whether Cap asked to stop in the last few seconds; the request is removed as it's read.
    public static func take(accessGroup: String? = nil, maxAge: TimeInterval = 15, now: Date = .now) -> Bool {
        var lookup = query(accessGroup)
        lookup[kSecReturnData as String] = kCFBooleanTrue
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return false }
        SecItemDelete(query(accessGroup) as CFDictionary)
        guard let seconds = Double(String(decoding: data, as: UTF8.self)) else { return false }
        let age = now.timeIntervalSince1970 - seconds
        return age >= -1 && age < maxAge
    }
}

/// Where screen recordings live: a folder Cap and its broadcast extension share, so the extension
/// can stop at once and leave the last uploads to Cap.
public enum ScreenRecordingStore {
    public static let groupIdentifier = "group.so.cap.mobile"
    /// Posted by the extension when it has handed a recording to Cap.
    public static let handOffNotification = "so.cap.mobile.broadcast.handed-off"

    public static var root: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupIdentifier)?
            .appending(path: "ScreenRecordings", directoryHint: .isDirectory)
    }

    public static func postHandOff() {
        notify_post(handOffNotification)
    }
}
