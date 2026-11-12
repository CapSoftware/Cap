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

private struct Rig {
    let analytics: Analytics
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
        // Nothing goes out by itself unless a test asks for it.
        configuration.flushInterval = .seconds(600)
        configuration.flushThreshold = 10_000
        configuration.retryDelay = .seconds(600)
        configure(&configuration)
        self.analytics = Analytics(
            api: api,
            app: Self.app,
            storage: file,
            configuration: configuration,
            isEnabled: isEnabled,
            currentUserId: { credentials.value?.userId },
            now: { clock.value }
        )
        self.transport = transport
        self.credentials = credentials
        self.status = status
        self.clock = clock
        self.storage = file
    }

    var requests: [URLRequest] { transport.requests }

    func events(_ index: Int) throws -> [[String: Any]] {
        try #require(try bodyJSON(requests[index])["events"] as? [[String: Any]])
    }

    func names(_ index: Int) throws -> [String] {
        try events(index).compactMap { $0["name"] as? String }
    }

    var hasStoredQueue: Bool { FileManager.default.fileExists(atPath: storage.path()) }
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
        let rig = Rig { $0.flushInterval = .milliseconds(400) }
        rig.analytics.track("app_opened")
        rig.analytics.track("screen_view", ["screen": "caps"])
        rig.analytics.track("screen_view", ["screen": "settings"])
        #expect(rig.requests.isEmpty)
        #expect(await eventually { rig.requests.count == 1 })
        try? await Task.sleep(for: .milliseconds(250))
        #expect(rig.requests.count == 1)
        #expect(try rig.names(0) == ["app_opened", "screen_view", "screen_view"])
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
        let rig = Rig { $0.flushInterval = .milliseconds(20) }
        await rig.analytics.flush()
        try? await Task.sleep(for: .milliseconds(100))
        #expect(rig.requests.isEmpty)
        #expect(!rig.hasStoredQueue)
    }

    @Test func sendsSignedOutEventsWithoutASessionAndTheRestWithIt() async throws {
        let rig = Rig(credentials: nil)
        rig.analytics.track("auth_started", ["method": "email"])
        rig.credentials.value = testCredentials
        rig.analytics.track("user_signed_in", ["method": "email"])
        await rig.analytics.flush()

        #expect(rig.requests.count == 2)
        #expect(rig.requests[0].value(forHTTPHeaderField: "Authorization") == nil)
        #expect(try rig.names(0) == ["auth_started"])
        #expect(rig.requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer \(testCredentials.apiKey)")
        #expect(try rig.names(1) == ["user_signed_in"])
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
        #expect(rig.requests.count == 2)
        #expect(try rig.names(1) == ["auth_started"])

        rig.credentials.value = testCredentials
        await rig.analytics.flush()
        #expect(rig.requests.count == 2)
        #expect(!rig.hasStoredQueue)
    }

    @Test func keepsEventsThroughAFailureAndRetriesByItself() async throws {
        let rig = Rig { $0.retryDelay = .milliseconds(60) }
        rig.status.value = 503
        rig.analytics.track("upload_started", ["source": "photos"])
        await rig.analytics.flush()
        #expect(rig.requests.count == 1)
        #expect(rig.hasStoredQueue)

        rig.status.value = 200
        #expect(await eventually { rig.requests.count == 2 })
        #expect(try rig.names(1) == ["upload_started"])
        #expect(await eventually { !rig.hasStoredQueue })
        try? await Task.sleep(for: .milliseconds(200))
        #expect(rig.requests.count == 2)
    }

    @Test func backsOffLongerAfterEachFailure() async {
        let rig = Rig {
            $0.retryDelay = .milliseconds(40)
            $0.maxRetryDelay = .milliseconds(160)
        }
        rig.status.value = 0
        rig.analytics.track("app_opened")
        let started = ContinuousClock.now
        await rig.analytics.flush()
        // One attempt now, then retries 40, 80 and 160 ms apart: a fourth attempt cannot land before 280 ms.
        #expect(await eventually { rig.requests.count == 4 })
        #expect(ContinuousClock.now - started >= .milliseconds(270))
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
        let rig = Rig { $0.capacity = 20_000; $0.batchLimit = 50 }
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
        try await api.trackEvents(batch, userId: nil)
        #expect(transport.requests.count == 2)
        #expect(transport.requests[0].value(forHTTPHeaderField: "Authorization") != nil)
        #expect(transport.requests[1].value(forHTTPHeaderField: "Authorization") == nil)
    }
}
