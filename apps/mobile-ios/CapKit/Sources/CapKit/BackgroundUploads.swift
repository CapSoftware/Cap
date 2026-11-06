import Foundation
import Synchronization

/// An upload handed to the background session. Persisted so a relaunched app can finish it.
public struct PendingUpload: Codable, Sendable, Hashable, Identifiable {
    public enum State: String, Codable, Sendable {
        /// Bytes are moving to storage.
        case uploading
        /// Storage has the file; Cap still needs to be told so processing can start.
        case uploaded
    }

    public let capId: String
    public let shareUrl: String
    public let rawFileKey: String
    public let contentLength: Int64
    public let title: String
    public let userId: String
    public let isImage: Bool
    public let sourceFile: String
    public let temporaryBody: String?
    public var taskIdentifier: Int?
    public var state: State
    public let createdAt: Date

    public var id: String { capId }

    public init(capId: String, shareUrl: String, rawFileKey: String, contentLength: Int64, title: String, userId: String, isImage: Bool, sourceFile: String, temporaryBody: String?, createdAt: Date = .now) {
        self.capId = capId
        self.shareUrl = shareUrl
        self.rawFileKey = rawFileKey
        self.contentLength = contentLength
        self.title = title
        self.userId = userId
        self.isImage = isImage
        self.sourceFile = sourceFile
        self.temporaryBody = temporaryBody
        self.taskIdentifier = nil
        self.state = .uploading
        self.createdAt = createdAt
    }
}

public enum BackgroundUploadEvent: Sendable {
    case progress(capId: String, sent: Int64, total: Int64)
    case uploaded(PendingUpload)
    case failed(PendingUpload, UploadError)
}

/// Runs uploads in a background `URLSession`, so they keep going when Cap is suspended or quit,
/// and keeps a small on-disk record of each one so it can be completed after a relaunch.
public final class BackgroundUploads: NSObject, Sendable, URLSessionDataDelegate {
    public static let sessionIdentifier = "so.cap.mobile.uploads"

    private struct State {
        var records: [String: PendingUpload] = [:]
        var finishEvents: (@Sendable () -> Void)?
    }

    private let state = Mutex(State())
    private let session = Mutex<URLSession?>(nil)
    private let continuation: AsyncStream<BackgroundUploadEvent>.Continuation
    public let events: AsyncStream<BackgroundUploadEvent>
    /// Prepared files and multipart bodies live here, outside tmp, until their upload ends.
    public let directory: URL
    private let storeURL: URL

    public init(directory: URL, configuration: URLSessionConfiguration? = nil) {
        self.directory = directory
        storeURL = directory.appending(path: "pending.json")
        (events, continuation) = AsyncStream.makeStream(of: BackgroundUploadEvent.self, bufferingPolicy: .unbounded)
        super.init()
        Self.prepareDirectory(directory)
        state.withLock { $0.records = Self.load(from: storeURL) }
        let configuration = configuration ?? Self.makeConfiguration()
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session.withLock { $0 = session }
    }

    public static func makeConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.background(withIdentifier: sessionIdentifier)
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.allowsCellularAccess = true
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        configuration.timeoutIntervalForResource = 60 * 60 * 24
        return configuration
    }

    // MARK: Uploads

    public func start(_ prepared: PreparedUploadRequest, record: PendingUpload) {
        guard let session = session.withLock({ $0 }) else { return }
        let task = session.uploadTask(with: prepared.request, fromFile: prepared.bodyFile)
        var record = record
        record.taskIdentifier = task.taskIdentifier
        record.state = .uploading
        save { $0[record.capId] = record }
        task.resume()
    }

    public var records: [PendingUpload] {
        state.withLock { Array($0.records.values) }.sorted { $0.createdAt < $1.createdAt }
    }

    /// Drops a finished or abandoned upload and deletes its files.
    public func remove(capId: String) {
        var removed: PendingUpload?
        save { records in removed = records.removeValue(forKey: capId) }
        if let removed { Self.deleteFiles(of: removed) }
    }

    /// Cancels everything and deletes every staged file. Used on sign out.
    public func cancelAll() async {
        let all = state.withLock { state -> [PendingUpload] in
            let all = Array(state.records.values)
            state.records.removeAll()
            return all
        }
        persist([:])
        for record in all { Self.deleteFiles(of: record) }
        if let session = session.withLock({ $0 }) {
            for task in await session.allTasks { task.cancel() }
        }
    }

    /// Reports uploads whose transfer the system no longer knows about, so they don't stay pending forever.
    public func reconcile() async {
        guard let session = session.withLock({ $0 }) else { return }
        let live = Set(await session.allTasks.map(\.taskIdentifier))
        let orphaned = state.withLock { state in
            state.records.values.filter { $0.state == .uploading && !live.contains($0.taskIdentifier ?? -1) }
        }
        for record in orphaned {
            continuation.yield(.failed(record, .rejected(status: 0)))
        }
    }

    public func setFinishEventsHandler(_ handler: @escaping @Sendable () -> Void) {
        state.withLock { $0.finishEvents = handler }
    }

    // MARK: URLSession delegate

    public func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard let record = record(for: task) else { return }
        let total = totalBytesExpectedToSend > 0 ? totalBytesExpectedToSend : record.contentLength
        continuation.yield(.progress(capId: record.capId, sent: totalBytesSent, total: total))
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        guard var record = record(for: task) else { return }
        if let error {
            continuation.yield(.failed(record, .transport(CapAPIError.from(error))))
            return
        }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            continuation.yield(.failed(record, .rejected(status: status)))
            return
        }
        record.state = .uploaded
        let uploaded = record
        save { $0[uploaded.capId] = uploaded }
        // Storage has the bytes; the staged copies aren't needed for completing the upload.
        Self.deleteFiles(of: uploaded)
        continuation.yield(.uploaded(uploaded))
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let handler = state.withLock { state -> (@Sendable () -> Void)? in
            let handler = state.finishEvents
            state.finishEvents = nil
            return handler
        }
        if let handler { DispatchQueue.main.async(execute: handler) }
    }

    // MARK: Storage

    private func record(for task: URLSessionTask) -> PendingUpload? {
        state.withLock { $0.records.values.first { $0.taskIdentifier == task.taskIdentifier } }
    }

    private func save(_ change: (inout [String: PendingUpload]) -> Void) {
        let snapshot = state.withLock { state in
            change(&state.records)
            return state.records
        }
        persist(snapshot)
    }

    private func persist(_ records: [String: PendingUpload]) {
        guard let data = try? CapJSON.encoder().encode(records) else { return }
        try? data.write(to: storeURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private static func load(from url: URL) -> [String: PendingUpload] {
        guard let data = try? Data(contentsOf: url) else { return [:] }
        return (try? CapJSON.decoder().decode([String: PendingUpload].self, from: data)) ?? [:]
    }

    private static func prepareDirectory(_ directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = directory
        try? url.setResourceValues(values)
    }

    private static func deleteFiles(of record: PendingUpload) {
        try? FileManager.default.removeItem(atPath: record.sourceFile)
        if let body = record.temporaryBody { try? FileManager.default.removeItem(atPath: body) }
    }

    /// Deletes staged files that no pending upload references, such as leftovers from a crash mid-prepare.
    /// Matches by file name: staged files have unique names, and the same folder can be reported
    /// through different paths (`/var` and `/private/var`).
    public func removeOrphanedFiles(olderThan: TimeInterval = 10 * 60) {
        let referenced = state.withLock { state in
            Set(state.records.values.flatMap { [$0.sourceFile, $0.temporaryBody].compactMap { $0 } }.map { URL(fileURLWithPath: $0).lastPathComponent })
        }
        guard let items = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        // Files being prepared right now have no record yet; only sweep ones left behind a while ago.
        let cutoff = Date.now.addingTimeInterval(-olderThan)
        for item in items where item.lastPathComponent != storeURL.lastPathComponent && !referenced.contains(item.lastPathComponent) {
            let modified = (try? item.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            guard modified < cutoff else { continue }
            try? FileManager.default.removeItem(at: item)
        }
    }
}
