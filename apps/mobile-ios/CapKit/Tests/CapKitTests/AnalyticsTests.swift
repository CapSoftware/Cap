import Foundation
import Synchronization
import Testing
@testable import CapKit

private final class Box<Value: Sendable>: Sendable {
    private let state: Mutex<Value>
    init(_ value: Value) { state = Mutex(value) }
    var value: Value {
        get { state.withLock { $0 } }
        set { state.withLock { $0 = newValue } }
    }
}

/// Stands in for the clock the queue waits on: every wait is recorded and only ends when a test says so, so no
/// test depends on how fast the machine running it is.
private final class ManualTimers: Sendable {
    private struct State {
        var delays: [Duration] = []
        var held: [CheckedContinuation<Void, Never>] = []
    }

    private let state = Mutex(State())

    var delays: [Duration] { state.withLock { $0.delays } }

    func sleep(_ delay: Duration) async {
        await withCheckedContinuation { continuation in
            state.withLock {
                $0.delays.append(delay)
                $0.held.append(continuation)
            }
        }
    }

    /// Ends every wait. One the queue has cancelled wakes up and does nothing.
    func fire() {
        let held = state.withLock { state in
            defer { state.held = [] }
            return state.held
        }
        for continuation in held { continuation.resume() }
    }
}

private struct Rig {
    let analytics: Analytics
    let timers = ManualTimers()
    let transport: RecordingTransport
    let credentials: Box<CredentialSnapshot?>
    let status: Box<Int>
    let clock: Box<Date>
    let storage: URL

    static let app = AnalyticsApp(version: "1.0.4", build: "2026111201", os: "26.1", device: .phone)
    static let start = Date(timeIntervalSince1970: 1_800_000_000)

    init(
        credentials initial: CredentialSnapshot? = testCredentials,
        storage: URL? = nil,
        isEnabled: Bool = true,
        configure: (inout Analytics.Configuration) -> Void = { _ in }
    ) {
        let credentials = Box(initial)
        let status = Box(200)
        let clock = Box(Self.start)
        // 0 stands for a phone with no connection.
        let transport = RecordingTransport { _ in
            let code = status.value
            if code == 0 { throw URLError(.notConnectedToInternet) }
            return (code, Data(#"{"success":true}"#.utf8))
        }
        let api = CapAPI(environment: .production, transport: transport, credentials: { credentials.value })
        let file = storage ?? FileManager.default.temporaryDirectory
            .appending(path: "analytics-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
            .appending(path: "queue.json")
        var configuration = Analytics.Configuration()
        configuration.flushThreshold = 10_000
        configure(&configuration)
        let timers = timers
        self.analytics = Analytics(
            api: api,
            app: Self.app,
            storage: file,
            configuration: configuration,
            isEnabled: isEnabled,
            currentUserId: { credentials.value?.userId },
            now: { clock.value },
            sleep: { await timers.sleep($0) }
        )
        self.transport = transport
        self.credentials = credentials
        self.status = status
        self.clock = clock
        self.storage = file
    }

    var requests: [URLRequest] { transport.requests }

    func events(_ index: Int) throws -> [[String: Any]] {
        let requests = requests
        try #require(requests.indices.contains(index))
        return try #require(try bodyJSON(requests[index])["events"] as? [[String: Any]])
    }

    /// Timers register from their own tasks, so the order they appear in is not the order they were asked for.
    func waits(_ seconds: Int...) -> Bool {
        timers.delays.sorted() == seconds.map { Duration.seconds($0) }.sorted()
    }

    func names(_ index: Int) throws -> [String] {
        try events(index).compactMap { $0["name"] as? String }
    }

    var hasStoredQueue: Bool { FileManager.default.fileExists(atPath: storage.path()) }
}

/// Holds every request until `open`, like a connection that has stalled.
private final class GatedTransport: HTTPTransport {
    private struct State {
        var requests: [URLRequest] = []
        var held: [CheckedContinuation<Void, Never>] = []
        var isOpen = false
    }

    private let state = Mutex(State())

    var requests: [URLRequest] { state.withLock { $0.requests } }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        await withCheckedContinuation { continuation in
            let passes = state.withLock { state in
                state.requests.append(request)
                if !state.isOpen { state.held.append(continuation) }
                return state.isOpen
            }
            if passes { continuation.resume() }
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (Data(#"{"success":true}"#.utf8), response)
    }

    func open() {
        let held = state.withLock { state in
            state.isOpen = true
            defer { state.held = [] }
            return state.held
        }
        for continuation in held { continuation.resume() }
    }
}

private func eventually(_ condition: @Sendable () -> Bool) async -> Bool {
    for _ in 0..<500 {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

@Suite struct AnalyticsTests {
    @Test func sendsWhatHappenedInOneSignedRequest() async throws {
        let rig = Rig()
        rig.analytics.track("app_opened", ["signed_in": true])
        rig.clock.value = Rig.start.addingTimeInterval(2.5)
        rig.analytics.track("recording_started", ["mode": "camera", "microphone": false, "segments": 3, "seconds": 1.5])
        rig.clock.value = Rig.start.addingTimeInterval(4)
        await rig.analytics.flush()

        #expect(rig.requests.count == 1)
        let request = rig.requests[0]
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "https://cap.so/api/mobile/events")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(testCredentials.apiKey)")

        let body = try bodyJSON(request)
        #expect(body["sentAt"] as? Int == 1_800_000_004_000)
        #expect(body["app"] as? [String: String] == ["version": "1.0.4", "build": "2026111201", "os": "26.1", "device": "phone"])
        let events = try rig.events(0)
        #expect(events.count == 2)
        #expect(events[0]["name"] as? String == "app_opened")
        #expect(events[0]["timestamp"] as? Int == 1_800_000_000_000)
        #expect(events[0]["properties"] as? [String: Bool] == ["signed_in": true])
        #expect(events[1]["name"] as? String == "recording_started")
        #expect(events[1]["timestamp"] as? Int == 1_800_000_002_500)
        let properties = try #require(events[1]["properties"] as? [String: Any])
        #expect(properties["mode"] as? String == "camera")
        #expect(properties["microphone"] as? Bool == false)
        #expect(properties["segments"] as? Int == 3)
        #expect(properties["seconds"] as? Double == 1.5)
        #expect(!rig.hasStoredQueue)
    }

    @Test func waitsForTheIntervalThenSendsOnce() async throws {
        let rig = Rig()
        rig.analytics.track("app_opened")
        rig.analytics.track("screen_view", ["screen": "caps"])
        rig.analytics.track("screen_view", ["screen": "settings"])
        #expect(await eventually { rig.waits(30) })
        #expect(rig.requests.isEmpty)

        rig.timers.fire()
        #expect(await eventually { rig.requests.count == 1 })
        #expect(try rig.names(0) == ["app_opened", "screen_view", "screen_view"])
        await rig.analytics.flush()
        #expect(rig.requests.count == 1)
        #expect(rig.waits(30))
    }

    @Test func sendsWithoutWaitingOnceEnoughEventsQueue() async throws {
        let rig = Rig { $0.flushThreshold = 5 }
        for index in 0..<5 { rig.analytics.track("cap_opened", ["position": .int(index)]) }
        #expect(await eventually { rig.requests.count == 1 })
        #expect(try rig.events(0).count == 5)
    }

    @Test func splitsALongQueueIntoBatches() async throws {
        let rig = Rig { $0.batchLimit = 10 }
        for index in 0..<25 { rig.analytics.track("cap_opened", ["position": .int(index)]) }
        await rig.analytics.flush()
        #expect(rig.requests.count == 3)
        #expect(try (0..<3).map { try rig.events($0).count } == [10, 10, 5])
        let positions = try (0..<3).flatMap { try rig.events($0) }.compactMap { ($0["properties"] as? [String: Int])?["position"] }
        #expect(positions == Array(0..<25))
    }

    @Test func doesNothingWithNothingToSend() async {
        let rig = Rig()
        await rig.analytics.flush()
        #expect(rig.requests.isEmpty)
        #expect(rig.timers.delays.isEmpty)
        #expect(!rig.hasStoredQueue)
    }

    @Test func holdsSignedOutEventsUntilSomeoneSignsIn() async throws {
        let rig = Rig(credentials: nil)
        rig.analytics.track("app_opened", ["signed_in": false])
        rig.analytics.track("auth_started", ["method": "email"])
        await rig.analytics.flush()
        #expect(rig.requests.isEmpty)
        #expect(rig.hasStoredQueue)
        #expect(rig.timers.delays.isEmpty)

        rig.credentials.value = testCredentials
        rig.analytics.track("user_signed_in", ["method": "email"])
        await rig.analytics.flush()
        #expect(rig.requests.count == 1)
        #expect(rig.requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer \(testCredentials.apiKey)")
        #expect(try rig.names(0) == ["app_opened", "auth_started", "user_signed_in"])
        #expect(!rig.hasStoredQueue)
    }

    @Test func neverSendsOneUsersEventsUnderAnothersSession() async throws {
        let rig = Rig()
        rig.status.value = 0
        rig.analytics.track("cap_opened")
        await rig.analytics.flush()
        #expect(rig.requests.count == 1)

        rig.status.value = 200
        rig.credentials.value = CredentialSnapshot(apiKey: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", userId: "user_456")
        rig.analytics.track("app_opened")
        await rig.analytics.flush()
        #expect(rig.requests.count == 2)
        #expect(try rig.names(1) == ["app_opened"])

        rig.credentials.value = testCredentials
        await rig.analytics.flush()
        #expect(rig.requests.count == 3)
        #expect(try rig.names(2) == ["cap_opened"])
        #expect(rig.requests[2].value(forHTTPHeaderField: "Authorization") == "Bearer \(testCredentials.apiKey)")
    }

    @Test func forgetsAUsersUnsentEventsOnSignOut() async throws {
        let rig = Rig()
        rig.status.value = 0
        rig.analytics.track("cap_opened")
        await rig.analytics.flush()
        #expect(rig.hasStoredQueue)

        rig.analytics.signedOut()
        rig.credentials.value = nil
        rig.status.value = 200
        rig.analytics.track("auth_started")
        await rig.analytics.flush()
        #expect(rig.requests.count == 1)

        rig.credentials.value = CredentialSnapshot(apiKey: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", userId: "user_456")
        await rig.analytics.flush()
        #expect(rig.requests.count == 2)
        #expect(try rig.names(1) == ["auth_started"])
        #expect(!rig.hasStoredQueue)
    }

    @Test func keepsWhatIsQueuedWhenTheServerRejectsTheSession() async throws {
        let rig = Rig()
        rig.status.value = 401
        rig.analytics.track("cap_opened")
        await rig.analytics.flush()
        #expect(rig.requests.count == 1)
        #expect(rig.hasStoredQueue)

        rig.status.value = 200
        await rig.analytics.flush()
        #expect(rig.requests.count == 2)
        #expect(try rig.names(1) == ["cap_opened"])
    }

    @Test func keepsEventsThroughAFailureAndRetriesByItself() async throws {
        let rig = Rig { $0.retryDelay = .seconds(45) }
        rig.status.value = 503
        rig.analytics.track("upload_started", ["source": "photos"])
        await rig.analytics.flush()
        #expect(rig.requests.count == 1)
        #expect(rig.hasStoredQueue)
        #expect(await eventually { rig.waits(30, 45) })

        rig.status.value = 200
        rig.timers.fire()
        #expect(await eventually { rig.requests.count == 2 })
        #expect(try rig.names(1) == ["upload_started"])
        await rig.analytics.flush()
        #expect(!rig.hasStoredQueue)
        #expect(rig.requests.count == 2)
        #expect(rig.waits(30, 45))
    }

    @Test func backsOffLongerAfterEachFailure() async {
        let rig = Rig {
            $0.retryDelay = .seconds(40)
            $0.maxRetryDelay = .seconds(160)
        }
        rig.status.value = 0
        rig.analytics.track("app_opened")
        await rig.analytics.flush()
        #expect(await eventually { rig.requests.count == 1 && rig.waits(30, 40) })
        rig.timers.fire()
        #expect(await eventually { rig.requests.count == 2 && rig.waits(30, 40, 80) })
        rig.timers.fire()
        #expect(await eventually { rig.requests.count == 3 && rig.waits(30, 40, 80, 160) })
        rig.timers.fire()
        #expect(await eventually { rig.requests.count == 4 && rig.waits(30, 40, 80, 160, 160) })
    }

    @Test func savesWhatIsWaitingWhileARequestIsStillOut() async throws {
        let transport = GatedTransport()
        let storage = FileManager.default.temporaryDirectory
            .appending(path: "analytics-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
            .appending(path: "queue.json")
        let timers = ManualTimers()
        let analytics = Analytics(
            api: CapAPI(environment: .production, transport: transport, credentials: { testCredentials }),
            app: Rig.app,
            storage: storage,
            currentUserId: { testCredentials.userId },
            sleep: { await timers.sleep($0) }
        )
        let saved: @Sendable () -> [String] = {
            guard let data = try? Data(contentsOf: storage),
                  let events = try? JSONDecoder().decode([Analytics.StoredEvent].self, from: data)
            else { return [] }
            return events.map(\.name)
        }

        analytics.track("app_opened")
        let first = Task { await analytics.flush() }
        #expect(await eventually { transport.requests.count == 1 })

        // The app leaves the screen while that request hangs.
        analytics.track("cap_opened")
        let second = Task { await analytics.flush() }
        #expect(await eventually { saved() == ["app_opened", "cap_opened"] })
        #expect(transport.requests.count == 1)

        transport.open()
        await first.value
        await second.value
        #expect(transport.requests.count == 2)
        let later = try #require(try bodyJSON(transport.requests[1])["events"] as? [[String: Any]])
        #expect(later.compactMap { $0["name"] as? String } == ["cap_opened"])
        #expect(saved().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: storage.path()))
    }

    @Test func sendsAFullBatchThatQueuedWhileARequestWasOut() async throws {
        let transport = GatedTransport()
        let timers = ManualTimers()
        var configuration = Analytics.Configuration()
        configuration.flushThreshold = 3
        let analytics = Analytics(
            api: CapAPI(environment: .production, transport: transport, credentials: { testCredentials }),
            app: Rig.app,
            storage: nil,
            configuration: configuration,
            currentUserId: { testCredentials.userId },
            sleep: { await timers.sleep($0) }
        )
        for _ in 0..<3 { analytics.track("cap_opened") }
        #expect(await eventually { transport.requests.count == 1 })
        for _ in 0..<3 { analytics.track("comment_created") }

        transport.open()
        #expect(await eventually { transport.requests.count == 2 })
        let later = try #require(try bodyJSON(transport.requests[1])["events"] as? [[String: Any]])
        #expect(later.compactMap { $0["name"] as? String } == ["comment_created", "comment_created", "comment_created"])
        await analytics.flush()
        #expect(transport.requests.count == 2)
    }

    @Test func doesNotSpinWhenTheSessionItWasToldAboutIsNotThere() async {
        let transport = RecordingTransport { _ in (200, Data(#"{"success":true}"#.utf8)) }
        let timers = ManualTimers()
        let stamps = Box(0)
        var configuration = Analytics.Configuration()
        configuration.flushThreshold = 1
        let analytics = Analytics(
            api: CapAPI(environment: .production, transport: transport, credentials: { nil }),
            app: Rig.app,
            storage: nil,
            configuration: configuration,
            currentUserId: { testCredentials.userId },
            now: {
                stamps.value += 1
                return Rig.start
            },
            sleep: { await timers.sleep($0) }
        )
        analytics.track("cap_opened")
        await analytics.flush()
        await analytics.flush()
        try? await Task.sleep(for: .milliseconds(100))
        #expect(transport.requests.isEmpty)
        // One stamp for the event, then a few per round. A round that restarted itself would run this into the thousands.
        #expect(stamps.value < 20)
    }

    @Test func leavesNoTimerRunningForEventsItMayNotSend() async throws {
        let rig = Rig()
        rig.status.value = 0
        rig.analytics.track("cap_opened")
        await rig.analytics.flush()
        #expect(await eventually { rig.waits(30, 30) })

        rig.status.value = 200
        rig.credentials.value = nil
        await rig.analytics.flush()
        rig.timers.fire()
        await rig.analytics.flush()
        try? await Task.sleep(for: .milliseconds(100))
        #expect(rig.requests.count == 1)
        #expect(rig.waits(30, 30))
    }

    @Test func sendsWhatAnEarlierLaunchCouldNot() async throws {
        let first = Rig()
        first.status.value = 0
        first.analytics.track("recording_started", ["mode": "screen"])
        first.analytics.track("recording_completed", ["mode": "screen"])
        await first.analytics.flush()
        #expect(first.hasStoredQueue)

        let second = Rig(storage: first.storage)
        second.analytics.track("app_opened")
        await second.analytics.flush()
        #expect(second.requests.count == 1)
        #expect(try second.names(0) == ["recording_started", "recording_completed", "app_opened"])
        #expect(!second.hasStoredQueue)
    }

    @Test func ignoresAStoredQueueItCannotRead() async throws {
        let rig = Rig()
        try FileManager.default.createDirectory(at: rig.storage.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: rig.storage)
        rig.analytics.track("app_opened")
        await rig.analytics.flush()
        #expect(try rig.names(0) == ["app_opened"])
        #expect(!rig.hasStoredQueue)
    }

    @Test func dropsABatchTheServerRefuses() async throws {
        let rig = Rig()
        rig.status.value = 400
        rig.analytics.track("cap_opened")
        await rig.analytics.flush()
        #expect(rig.requests.count == 1)
        #expect(!rig.hasStoredQueue)

        rig.status.value = 200
        rig.analytics.track("app_opened")
        await rig.analytics.flush()
        #expect(rig.requests.count == 2)
        #expect(try rig.names(1) == ["app_opened"])
    }

    @Test func goesQuietOnAServerWithoutTheEndpoint() async {
        let rig = Rig { $0.flushThreshold = 1 }
        rig.status.value = 404
        rig.analytics.track("app_opened")
        await rig.analytics.flush()
        #expect(rig.requests.count == 1)

        rig.status.value = 200
        rig.analytics.track("cap_opened")
        rig.analytics.track("cap_opened")
        await rig.analytics.flush()
        #expect(rig.requests.count == 1)
        #expect(!rig.hasStoredQueue)
    }

    @Test func dropsEventsOlderThanAWeek() async throws {
        let rig = Rig()
        rig.status.value = 0
        rig.analytics.track("cap_opened")
        await rig.analytics.flush()

        rig.status.value = 200
        rig.clock.value = Rig.start.addingTimeInterval(8 * 24 * 60 * 60)
        rig.analytics.track("app_opened")
        await rig.analytics.flush()
        #expect(rig.requests.count == 2)
        #expect(try rig.names(1) == ["app_opened"])
    }

    @Test func keepsOnlyTheNewestEventsWhenFull() async throws {
        let rig = Rig { $0.capacity = 5 }
        rig.status.value = 0
        for index in 0..<8 { rig.analytics.track("cap_opened", ["position": .int(index)]) }
        await rig.analytics.flush()

        rig.status.value = 200
        await rig.analytics.flush()
        let positions = try rig.events(1).compactMap { ($0["properties"] as? [String: Int])?["position"] }
        #expect(positions == [3, 4, 5, 6, 7])
    }

    @Test func cleansNamesAndValuesBeforeTheyQueue() async throws {
        let rig = Rig()
        rig.analytics.track("Bad Name")
        rig.analytics.track("__identify")
        rig.analytics.track("")
        rig.analytics.track(String(repeating: "a", count: 65))
        rig.analytics.track("cap_opened", [
            "source": .string(String(repeating: "x", count: 500)),
            "__ip": "198.51.100.1",
            "profileId": "someone",
            "ratio": .double(.infinity),
            "count": 2,
        ])
        await rig.analytics.flush()

        let events = try rig.events(0)
        #expect(events.count == 1)
        let properties = try #require(events[0]["properties"] as? [String: Any])
        #expect(Set(properties.keys) == ["source", "count"])
        #expect((properties["source"] as? String)?.count == 120)
    }

    @Test func sendsNothingWhenTurnedOff() async {
        let rig = Rig(isEnabled: false)
        rig.analytics.track("app_opened")
        await rig.analytics.flush()
        rig.analytics.signedOut()
        #expect(rig.requests.isEmpty)
        #expect(!rig.hasStoredQueue)
    }

    @Test func recordingAnEventCostsMicroseconds() async throws {
        let rig = Rig { $0.capacity = 20_000; $0.flushThreshold = 1_000_000 }
        let count = 10_000
        let clock = ContinuousClock()
        let elapsed = clock.measure {
            for index in 0..<count {
                rig.analytics.track("cap_opened", ["source": "library", "owned": true, "position": .int(index)])
            }
        }
        let perCall = elapsed / count
        print("Analytics.track: \(count) calls in \(elapsed), \(perCall) each")
        // Loose enough for a busy CI machine, tight enough to catch a file write or a lock held across a request.
        #expect(perCall < .microseconds(200))
        #expect(rig.requests.isEmpty)
    }

    @Test func readsTheAppAndDeviceItRunsOn() {
        #expect(AnalyticsApp.numeric("1.0.4", separators: true) == "1.0.4")
        #expect(AnalyticsApp.numeric("1.0 (beta)", separators: true) == nil)
        #expect(AnalyticsApp.numeric("1..2", separators: true) == nil)
        #expect(AnalyticsApp.numeric("1.2.3.4.5", separators: true) == nil)
        #expect(AnalyticsApp.numeric("2026111201", separators: false) == "2026111201")
        #expect(AnalyticsApp.numeric("12a", separators: false) == nil)
        #expect(AnalyticsApp.numeric(nil, separators: false) == nil)
        let app = AnalyticsApp.current()
        #expect(AnalyticsApp.numeric(app.os, separators: true) == app.os)
        #expect(AnalyticsApp.numeric(app.version, separators: true) == app.version)
        #expect(AnalyticsApp.numeric(app.build, separators: false) == app.build)
    }
}

@Suite struct AnalyticsRequestTests {
    @Test func refusesToSendAsAUserWhoIsNoLongerSignedIn() async throws {
        let (api, transport) = makeAPI { _ in (200, Data(#"{"success":true}"#.utf8)) }
        let batch = AnalyticsBatch(sentAt: 1, app: Rig.app, events: [.init(name: "app_opened", timestamp: 1, properties: nil)])
        await #expect(throws: CapAPIError.missingSession) {
            try await api.trackEvents(batch, userId: "user_456")
        }
        #expect(transport.requests.isEmpty)
        try await api.trackEvents(batch, userId: testCredentials.userId)
        #expect(transport.requests.count == 1)
        #expect(transport.requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer \(testCredentials.apiKey)")

        let (signedOut, unsent) = makeAPI(credentials: nil) { _ in (200, Data(#"{"success":true}"#.utf8)) }
        await #expect(throws: CapAPIError.missingSession) {
            try await signedOut.trackEvents(batch, userId: testCredentials.userId)
        }
        #expect(unsent.requests.isEmpty)
    }
}
