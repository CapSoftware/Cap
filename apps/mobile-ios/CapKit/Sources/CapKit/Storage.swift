import Foundation
import Security
import Synchronization

public protocol CredentialPersisting: Sendable {
    func load() -> CredentialSnapshot?
    func save(_ credentials: CredentialSnapshot) throws
    func delete()
}

public enum KeychainError: Error, Sendable, Equatable {
    case unexpectedStatus(OSStatus)
}

public struct KeychainCredentialStore: CredentialPersisting {
    private let service: String
    private let account: String
    private let accessGroup: String?

    /// - Parameter accessGroup: set by Cap's extensions to read the app's session; the app itself
    ///   leaves it nil and uses its default group, which is the same one.
    public init(service: String = "so.cap.mobile.session", account: String = "primary", accessGroup: String? = nil) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    private struct Payload: Codable {
        let apiKey: String
        let userId: String
    }

    private var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    public func load() -> CredentialSnapshot? {
        var query = baseQuery
        query[kSecReturnData as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let payload = try? JSONDecoder().decode(Payload.self, from: data),
              APIKeyValidator.isPlausible(payload.apiKey),
              CapID(payload.userId) != nil
        else { return nil }
        return CredentialSnapshot(apiKey: payload.apiKey, userId: payload.userId)
    }

    public func save(_ credentials: CredentialSnapshot) throws {
        let data = try JSONEncoder().encode(Payload(apiKey: credentials.apiKey, userId: credentials.userId))
        SecItemDelete(baseQuery as CFDictionary)
        var attributes = baseQuery
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    }

    public func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}

public final class InMemoryCredentialStore: CredentialPersisting {
    private let value: Mutex<CredentialSnapshot?>

    public init(_ initial: CredentialSnapshot? = nil) {
        value = Mutex(initial)
    }

    public func load() -> CredentialSnapshot? { value.withLock { $0 } }
    public func save(_ credentials: CredentialSnapshot) throws { value.withLock { $0 = credentials } }
    public func delete() { value.withLock { $0 = nil } }
}

public final class CredentialVault: Sendable {
    private let store: any CredentialPersisting
    private let current: Mutex<CredentialSnapshot?>

    public init(store: any CredentialPersisting) {
        self.store = store
        current = Mutex(store.load())
    }

    public var credentials: CredentialSnapshot? { current.withLock { $0 } }

    public func replace(with credentials: CredentialSnapshot) throws {
        try store.save(credentials)
        current.withLock { $0 = credentials }
    }

    @discardableResult
    public func clear(ifMatching expected: CredentialSnapshot? = nil) -> Bool {
        let cleared = current.withLock { value -> Bool in
            if let expected, value != expected { return false }
            value = nil
            return true
        }
        if cleared { store.delete() }
        return cleared
    }
}

public actor DiskCache {
    private let root: URL
    private let fileManager = FileManager.default

    public init(directoryName: String = "so.cap.mobile.snapshots", baseDirectory: URL? = nil) {
        let base = baseDirectory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        root = base.appending(path: directoryName, directoryHint: .isDirectory)
    }

    private func fileURL(namespace: String, key: String) -> URL? {
        guard CapID(namespace) != nil else { return nil }
        let safeKey = key.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" ? String($0) : "_" }.joined()
        guard !safeKey.isEmpty, safeKey.count <= 200 else { return nil }
        return root.appending(path: namespace, directoryHint: .isDirectory).appending(path: "\(safeKey).json")
    }

    public func read<Value: Decodable & Sendable>(_ type: Value.Type, namespace: String, key: String) -> Value? {
        guard let url = fileURL(namespace: namespace, key: key), let data = try? Data(contentsOf: url) else { return nil }
        return try? CapJSON.decoder().decode(Value.self, from: data)
    }

    public func write<Value: Encodable & Sendable>(_ value: Value, namespace: String, key: String) {
        guard let url = fileURL(namespace: namespace, key: key), let data = try? CapJSON.encoder().encode(value) else { return }
        do {
            try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutableURL = url
            try? mutableURL.setResourceValues(values)
        } catch {
            try? fileManager.removeItem(at: url)
        }
    }

    public func remove(namespace: String, key: String) {
        guard let url = fileURL(namespace: namespace, key: key) else { return }
        try? fileManager.removeItem(at: url)
    }

    public func removeAll() {
        try? fileManager.removeItem(at: root)
    }
}
