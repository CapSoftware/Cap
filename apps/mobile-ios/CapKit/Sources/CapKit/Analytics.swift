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
        case sent([UInt64], CapAPIError?)
    }

    private let commands: AsyncStream<Command>.Continuation
    private let currentUserId: @Sendable () -> String?
    private let now: @Sendable () -> Date
    private let isEnabled: Bool

    public init(
        api: CapAPI,
        app: AnalyticsApp,
        storage: URL?,
        configuration: Configuration = Configuration(),
        isEnabled: Bool = true,
        currentUserId: @escaping @Sendable () -> String?,
        now: @escaping @Sendable () -> Date = { Date() },
        sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }
    ) {
        // Unbounded, because losing the result of a send would leave the worker waiting for it forever. The worker
        // never waits on the network, so nothing builds up here.
        let (stream, continuation) = AsyncStream.makeStream(of: Command.self)
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
                sleep: sleep,
                commands: continuation
            )
            for await command in stream {
                worker.handle(command)
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
        commands.yield(.event(StoredEvent(name: name, time: Self.milliseconds(now()), properties: cleaned, userId: currentUserId())))
    }

    /// Saves what is waiting, then sends it, and returns once the attempt is over. Call it before the app is
    /// suspended: the save happens first, even while an earlier request is still out.
    public func flush() async {
        guard isEnabled else { return }
        await withCheckedContinuation { continuation in
            if case .terminated = commands.yield(.flush(continuation)) { continuation.resume() }
        }
    }

    /// Forgets the unsent events of the user who just signed out; nothing may send them any more.
    public func signedOut() {
        commands.yield(.signedOut)
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
    /// Only ever touched by the one task that reads the command stream. It never waits: a request runs in its own
    /// task and reports back through the stream, so events keep queueing and the queue can be saved meanwhile.
    struct Worker {
        private struct Queued {
            let id: UInt64
            let event: StoredEvent
        }

        let api: CapAPI
        let app: AnalyticsApp
        let storage: URL?
        let configuration: Configuration
        let currentUserId: @Sendable () -> String?
        let now: @Sendable () -> Date
        let sleep: @Sendable (Duration) async -> Void
        let commands: AsyncStream<Command>.Continuation

        private var pending: [Queued] = []
        private var nextId: UInt64 = 0
        private var loaded = false
        private var stored = false
        private var unsupported = false
        private var failures = 0
        private var timer: Task<Void, Never>?
        private var timerGeneration = 0
        private var sending = false
        /// A round of sends covers the events queued before it began, so later ones still wait to be batched.
        private var roundEnd: UInt64 = 0
        /// The session ended or changed mid-round, which stops the round.
        private var skipsUser = false
        /// Whether the current round sent anything. A round that sent nothing must not start another by itself.
        private var delivered = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        init(
            api: CapAPI,
            app: AnalyticsApp,
            storage: URL?,
            configuration: Configuration,
            currentUserId: @escaping @Sendable () -> String?,
            now: @escaping @Sendable () -> Date,
            sleep: @escaping @Sendable (Duration) async -> Void,
            commands: AsyncStream<Command>.Continuation
        ) {
            self.api = api
            self.app = app
            self.storage = storage
            self.configuration = configuration
            self.currentUserId = currentUserId
            self.now = now
            self.sleep = sleep
            self.commands = commands
        }

        mutating func handle(_ command: Command) {
            switch command {
            case let .event(event):
                guard !unsupported else { return }
                load()
                enqueue(event)
                trim()
                guard !sending else { return }
                let ready = readyCount()
                if failures == 0, ready >= configuration.flushThreshold {
                    beginRound()
                } else if ready > 0, timer == nil {
                    schedule(after: configuration.flushInterval)
                }
            case let .timer(generation):
                guard generation == timerGeneration else { return }
                timer = nil
                if !sending { beginRound() }
            case let .flush(continuation):
                load()
                save()
                waiters.append(continuation)
                if sending {
                    roundEnd = nextId
                } else {
                    beginRound()
                }
            case .signedOut:
                load()
                pending.removeAll { $0.event.userId != nil }
                if stored { save() }
            case let .sent(ids, error):
                sending = false
                finished(ids, error)
            }
        }

        private mutating func enqueue(_ event: StoredEvent) {
            pending.append(Queued(id: nextId, event: event))
            nextId += 1
        }

        private mutating func beginRound() {
            cancelTimer()
            guard !unsupported else { return endRound() }
            let oldest = Analytics.milliseconds(now().addingTimeInterval(-configuration.maxAge))
            pending.removeAll { $0.event.time < oldest }
            roundEnd = nextId
            skipsUser = false
            delivered = false
            sendNext()
        }

        /// What the signed-in user may send: their own events, and those from before anyone was signed in.
        private func isReady(_ event: StoredEvent, for user: String) -> Bool {
            event.userId == nil || event.userId == user
        }

        private func readyCount() -> Int {
            guard let user = currentUserId() else { return 0 }
            return pending.count { isReady($0.event, for: user) }
        }

        /// The server only takes events from a signed-in session, so nothing goes out while signed out. Events from
        /// before sign-in wait on the device for whoever signs in next.
        private mutating func sendNext() {
            guard !skipsUser, let user = currentUserId() else { return endRound() }
            let end = roundEnd
            let batch = pending.filter { $0.id < end && isReady($0.event, for: user) }.prefix(configuration.batchLimit)
            guard !batch.isEmpty else { return endRound() }
            let ids = batch.map(\.id)
            let body = AnalyticsBatch(
                sentAt: Analytics.milliseconds(now()),
                app: app,
                events: batch.map { AnalyticsBatch.Event(name: $0.event.name, timestamp: $0.event.time, properties: $0.event.properties.isEmpty ? nil : $0.event.properties) }
            )
            sending = true
            let api = api
            let commands = commands
            Task.detached(priority: .utility) {
                do {
                    try await api.trackEvents(body, userId: user)
                    commands.yield(.sent(ids, nil))
                } catch {
                    commands.yield(.sent(ids, CapAPIError.from(error)))
                }
            }
        }

        private mutating func finished(_ ids: [UInt64], _ error: CapAPIError?) {
            switch error {
            case nil:
                remove(ids)
                failures = 0
                delivered = true
                sendNext()
            case .notFound:
                // A server from before this endpoint existed. Stop asking until the next launch.
                unsupported = true
                pending.removeAll()
                endRound()
            case .missingSession, .unauthorized:
                // The session ended or changed. What is queued stays for the next one that may send it.
                skipsUser = true
                sendNext()
            case .badRequest, .payloadTooLarge, .conflict, .forbidden, .unexpectedStatus:
                // Refused for what it contains, so sending it again cannot work.
                remove(ids)
                sendNext()
            case .offline, .timedOut, .cancelled, .rateLimited, .server, .transport, .invalidResponse:
                failures += 1
                schedule(after: retryDelay)
                endRound(saving: true)
            }
        }

        private mutating func endRound(saving: Bool = false) {
            if saving || stored || !waiters.isEmpty { save() }
            for waiter in waiters { waiter.resume() }
            waiters.removeAll()
            guard timer == nil, !unsupported else { return }
            // Only events this session may send count; the rest wait for a sign-in without a timer running.
            let ready = readyCount()
            if delivered, failures == 0, ready >= configuration.flushThreshold {
                // Enough arrived while the last request was out.
                beginRound()
            } else if ready > 0 {
                schedule(after: configuration.flushInterval)
            }
        }

        private var retryDelay: Duration {
            let doubled = configuration.retryDelay * (1 << min(failures - 1, 16))
            return min(doubled, configuration.maxRetryDelay)
        }

        private mutating func remove(_ ids: [UInt64]) {
            let sent = Set(ids)
            pending.removeAll { sent.contains($0.id) }
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
            let sleep = sleep
            timer = Task.detached(priority: .utility) {
                await sleep(delay)
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
            let waiting = pending.map(\.event)
            pending.removeAll()
            for event in events + waiting { enqueue(event) }
            trim()
        }

        private mutating func save() {
            guard let storage else { return }
            let fileManager = FileManager.default
            guard !pending.isEmpty, let data = try? JSONEncoder().encode(pending.map(\.event)) else {
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
