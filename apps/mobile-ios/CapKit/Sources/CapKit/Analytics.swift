import Foundation

public enum AnalyticsValue: Sendable, Hashable, Codable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .int(value): try container.encode(value)
        case let .double(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        }
    }
}

extension AnalyticsValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .int(value) }
    public init(floatLiteral value: Double) { self = .double(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}

public struct AnalyticsApp: Sendable, Hashable, Encodable {
    public enum Device: String, Sendable, Encodable {
        case phone, tablet
    }

    public let version: String
    public let build: String
    public let os: String
    public let device: Device

    public init(version: String, build: String, os: String, device: Device) {
        self.version = version
        self.build = build
        self.os = os
        self.device = device
    }

    public static func current(bundle: Bundle = .main, processInfo: ProcessInfo = .processInfo) -> AnalyticsApp {
        let system = processInfo.operatingSystemVersion
        let os = [system.majorVersion, system.minorVersion, system.patchVersion].map(String.init).joined(separator: ".")
        return AnalyticsApp(
            version: numeric(bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String, separators: true) ?? "0",
            build: numeric(bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String, separators: false) ?? "0",
            os: os,
            device: hardwareModel(processInfo).hasPrefix("iPad") ? .tablet : .phone
        )
    }

    /// The server takes digits, and dots between them in a version; anything else would have the whole batch refused.
    static func numeric(_ value: String?, separators: Bool) -> String? {
        guard let value, !value.isEmpty, value.utf8.count <= (separators ? 43 : 20) else { return nil }
        let parts = separators ? value.split(separator: ".", omittingEmptySubsequences: false) : [Substring(value)]
        guard parts.count <= 4, parts.allSatisfy({ !$0.isEmpty && $0.utf8.count <= (separators ? 10 : 20) && $0.utf8.allSatisfy { (48...57).contains($0) } }) else { return nil }
        return value
    }

    static func hardwareModel(_ processInfo: ProcessInfo) -> String {
        if let simulated = processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { bytes in
            String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
        }
    }
}

public struct AnalyticsBatch: Sendable, Encodable {
    struct Event: Sendable, Encodable {
        let name: String
        let timestamp: Int64
        let properties: [String: AnalyticsValue]?
    }

    let sentAt: Int64
    let app: AnalyticsApp
    let events: [Event]
}

/// Usage events, recorded without waiting on anything and sent to Cap a batch at a time.
///
/// `track` only stamps the event and hands it to a background task. That task sends one request per batch, keeps
/// what could not be sent in a file, and does nothing at all while there is nothing to send.
public final class Analytics: Sendable {
    public struct Configuration: Sendable {
        /// How long the first unsent event waits for others to share its request.
        public var flushInterval: Duration = .seconds(30)
        /// Enough events to send without waiting for the interval.
        public var flushThreshold = 20
        public var batchLimit = 50
        /// The oldest events go first once this many are waiting.
        public var capacity = 500
        public var maxAge: TimeInterval = 7 * 24 * 60 * 60
        public var retryDelay: Duration = .seconds(30)
        public var maxRetryDelay: Duration = .seconds(300)

        public init() {}
    }

    struct StoredEvent: Sendable, Hashable, Codable {
        let name: String
        let time: Int64
        let properties: [String: AnalyticsValue]
        /// Who was signed in when it happened. It only decides which session may send the event.
        let userId: String?
    }

    enum Command: Sendable {
        case event(StoredEvent)
        case timer(Int)
        case flush(CheckedContinuation<Void, Never>)
        case signedOut
    }

    private static let bufferedCommands = 2048

    private let commands: AsyncStream<Command>.Continuation
    private let currentUserId: @Sendable () -> String?
    private let now: @Sendable () -> Date
    private let isEnabled: Bool

    /// - Parameter storage: The file that holds unsent events between launches, or nil to keep them in memory only.
    public init(
        api: CapAPI,
        app: AnalyticsApp,
        storage: URL?,
        configuration: Configuration = Configuration(),
        isEnabled: Bool = true,
        currentUserId: @escaping @Sendable () -> String?,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        let (stream, continuation) = AsyncStream.makeStream(of: Command.self, bufferingPolicy: .bufferingNewest(Self.bufferedCommands))
        commands = continuation
        self.currentUserId = currentUserId
        self.now = now
        self.isEnabled = isEnabled
        guard isEnabled else {
            continuation.finish()
            return
        }
        Task.detached(priority: .utility) {
            var worker = Worker(
                api: api,
                app: app,
                storage: storage,
                configuration: configuration,
                currentUserId: currentUserId,
                now: now,
                commands: continuation
            )
            for await command in stream {
                await worker.handle(command)
            }
        }
    }

    deinit {
        commands.finish()
    }

    public func track(_ name: String, _ properties: [String: AnalyticsValue] = [:]) {
        guard isEnabled, Self.isName(name, limit: 64) else { return }
        var cleaned: [String: AnalyticsValue] = [:]
        for (key, value) in properties where Self.isName(key, limit: 40) {
            switch value {
            case let .string(text) where text.count > Self.textLimit:
                cleaned[key] = .string(String(text.prefix(Self.textLimit)))
            case let .double(number) where !number.isFinite:
                continue
            default:
                cleaned[key] = value
            }
        }
        send(.event(StoredEvent(name: name, time: Self.milliseconds(now()), properties: cleaned, userId: currentUserId())))
    }

    /// Sends what is waiting now and saves whatever could not be sent. Call it before the app is suspended.
    public func flush() async {
        guard isEnabled else { return }
        await withCheckedContinuation { continuation in
            send(.flush(continuation))
        }
    }

    /// Forgets the unsent events of the user who just signed out; nothing may send them any more.
    public func signedOut() {
        send(.signedOut)
    }

    private func send(_ command: Command) {
        switch commands.yield(command) {
        case let .dropped(.flush(continuation)):
            // Pushed out of a full buffer before it was read; its caller must not wait forever.
            continuation.resume()
        case .terminated:
            if case let .flush(continuation) = command { continuation.resume() }
        default:
            break
        }
    }

    static let textLimit = 120

    static func milliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    /// Lowercase ASCII letters, digits and underscores, starting with a letter: the only names the server accepts.
    static func isName(_ value: String, limit: Int) -> Bool {
        let bytes = value.utf8
        guard let first = bytes.first, (97...122).contains(first), bytes.count <= limit else { return false }
        return bytes.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 95 }
    }
}

extension Analytics {
    /// Only ever touched by the one task that reads the command stream.
    struct Worker {
        let api: CapAPI
        let app: AnalyticsApp
        let storage: URL?
        let configuration: Configuration
        let currentUserId: @Sendable () -> String?
        let now: @Sendable () -> Date
        let commands: AsyncStream<Command>.Continuation

        private var pending: [StoredEvent] = []
        private var loaded = false
        private var stored = false
        private var unsupported = false
        private var failures = 0
        private var timer: Task<Void, Never>?
        private var timerGeneration = 0

        init(
            api: CapAPI,
            app: AnalyticsApp,
            storage: URL?,
            configuration: Configuration,
            currentUserId: @escaping @Sendable () -> String?,
            now: @escaping @Sendable () -> Date,
            commands: AsyncStream<Command>.Continuation
        ) {
            self.api = api
            self.app = app
            self.storage = storage
            self.configuration = configuration
            self.currentUserId = currentUserId
            self.now = now
            self.commands = commands
        }

        mutating func handle(_ command: Command) async {
            switch command {
            case let .event(event):
                guard !unsupported else { return }
                load()
                pending.append(event)
                trim()
                if failures == 0, pending.count >= configuration.flushThreshold {
                    await flush()
                } else if timer == nil {
                    schedule(after: configuration.flushInterval)
                }
            case let .timer(generation):
                guard generation == timerGeneration else { return }
                timer = nil
                await flush()
            case let .flush(continuation):
                load()
                // Saved first: the app may be suspended, then closed, while the request is still out.
                save()
                await flush()
                save()
                continuation.resume()
            case .signedOut:
                load()
                pending.removeAll { $0.userId != nil }
                if stored { save() }
            }
        }

        private mutating func flush() async {
            cancelTimer()
            guard !unsupported else { return }
            let oldest = Analytics.milliseconds(now().addingTimeInterval(-configuration.maxAge))
            pending.removeAll { $0.time < oldest }

            // Events from before sign-in go without a session; the rest only with the session they were recorded in.
            let user = currentUserId()
            let senders: [String?] = user == nil ? [nil] : [nil, user]
            for sender in senders {
                sending: while true {
                    let indices = pending.indices.filter { pending[$0].userId == sender }.prefix(configuration.batchLimit)
                    guard !indices.isEmpty else { break }
                    let batch = AnalyticsBatch(
                        sentAt: Analytics.milliseconds(now()),
                        app: app,
                        events: indices.map { index in
                            let event = pending[index]
                            return AnalyticsBatch.Event(name: event.name, timestamp: event.time, properties: event.properties.isEmpty ? nil : event.properties)
                        }
                    )
                    do {
                        try await api.trackEvents(batch, userId: sender)
                    } catch {
                        switch error {
                        case .notFound:
                            // A server from before this endpoint existed. Stop asking until the next launch.
                            unsupported = true
                            pending.removeAll()
                            save()
                            return
                        case .missingSession:
                            // The session changed while this was being sent. These wait for their user to be back.
                            break sending
                        case .badRequest, .payloadTooLarge, .conflict, .forbidden, .unauthorized, .unexpectedStatus:
                            // Refused for what it contains, so sending it again cannot work.
                            remove(indices)
                            continue sending
                        case .offline, .timedOut, .cancelled, .rateLimited, .server, .transport, .invalidResponse:
                            failures += 1
                            save()
                            schedule(after: retryDelay)
                            return
                        }
                    }
                    remove(indices)
                    failures = 0
                }
            }
            if stored { save() }
        }

        private var retryDelay: Duration {
            let doubled = configuration.retryDelay * (1 << min(failures - 1, 16))
            return min(doubled, configuration.maxRetryDelay)
        }

        private mutating func remove(_ indices: some Collection<Int>) {
            for index in indices.reversed() { pending.remove(at: index) }
        }

        private mutating func trim() {
            let extra = pending.count - configuration.capacity
            if extra > 0 { pending.removeFirst(extra) }
        }

        private mutating func cancelTimer() {
            timer?.cancel()
            timer = nil
            // A timer that already fired may still be waiting in the stream.
            timerGeneration += 1
        }

        private mutating func schedule(after delay: Duration) {
            timer?.cancel()
            timerGeneration += 1
            let generation = timerGeneration
            let commands = commands
            timer = Task.detached(priority: .utility) {
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled else { return }
                commands.yield(.timer(generation))
            }
        }

        private mutating func load() {
            guard !loaded else { return }
            loaded = true
            guard let storage, let data = try? Data(contentsOf: storage) else { return }
            stored = true
            guard let events = try? JSONDecoder().decode([StoredEvent].self, from: data) else { return }
            pending.insert(contentsOf: events, at: 0)
            trim()
        }

        private mutating func save() {
            guard let storage else { return }
            let fileManager = FileManager.default
            guard !pending.isEmpty, let data = try? JSONEncoder().encode(pending) else {
                if stored { try? fileManager.removeItem(at: storage) }
                stored = false
                return
            }
            do {
                try fileManager.createDirectory(at: storage.deletingLastPathComponent(), withIntermediateDirectories: true)
                // Readable while the phone is locked, so a background launch can still add to it.
                #if os(macOS)
                try data.write(to: storage, options: .atomic)
                #else
                try data.write(to: storage, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                #endif
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                var url = storage
                try? url.setResourceValues(values)
                stored = true
            } catch {
                try? fileManager.removeItem(at: storage)
                stored = false
            }
        }
    }
}
