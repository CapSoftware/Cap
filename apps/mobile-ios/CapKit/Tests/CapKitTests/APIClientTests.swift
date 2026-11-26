import Foundation
import Synchronization
import Testing
@testable import CapKit

final class RecordingTransport: HTTPTransport {
    private let state = Mutex<[URLRequest]>([])
    private let responder: @Sendable (URLRequest) throws -> (Int, Data)

    init(responder: @escaping @Sendable (URLRequest) throws -> (Int, Data)) {
        self.responder = responder
    }

    var requests: [URLRequest] { state.withLock { $0 } }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        state.withLock { $0.append(request) }
        let (status, data) = try responder(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (data, response)
    }
}

let testCredentials = CredentialSnapshot(apiKey: "0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e", userId: "user_123")

final class UnauthorizedLog: Sendable {
    private let state = Mutex<[CredentialSnapshot]>([])
    func append(_ snapshot: CredentialSnapshot) { state.withLock { $0.append(snapshot) } }
    var entries: [CredentialSnapshot] { state.withLock { $0 } }
}

func makeAPI(
    credentials: CredentialSnapshot? = testCredentials,
    unauthorized: UnauthorizedLog? = nil,
    responder: @escaping @Sendable (URLRequest) throws -> (Int, Data)
) -> (CapAPI, RecordingTransport) {
    let transport = RecordingTransport(responder: responder)
    let api = CapAPI(
        environment: .production,
        transport: transport,
        credentials: { credentials },
        onUnauthorized: { snapshot in unauthorized?.append(snapshot) }
    )
    return (api, transport)
}

func bodyJSON(_ request: URLRequest) throws -> [String: Any] {
    let data = try #require(request.httpBody)
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@Suite struct APIClientTests {
    @Test func attachesBearerOnlyToAuthenticatedRequests() async throws {
        let (api, transport) = makeAPI { request in
            if request.url?.path() == "/api/mobile/session/config" {
                return (200, Data(#"{"appleAuthAvailable":true,"googleAuthAvailable":false,"workosAuthAvailable":true}"#.utf8))
            }
            return (200, try fixture("bootstrap"))
        }
        let config = try await api.authConfig()
        #expect(config.googleAuthAvailable == false)
        _ = try await api.bootstrap()
        let requests = transport.requests
        #expect(requests[0].value(forHTTPHeaderField: "Authorization") == nil)
        #expect(requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer \(testCredentials.apiKey)")
        #expect(requests[1].url?.absoluteString == "https://cap.so/api/mobile/bootstrap")
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Cookie") == nil })
    }

    @Test func refusesAuthenticatedRequestsWithoutSession() async {
        let (api, transport) = makeAPI(credentials: nil) { _ in (200, Data("{}".utf8)) }
        await #expect(throws: CapAPIError.missingSession) {
            _ = try await api.bootstrap()
        }
        #expect(transport.requests.isEmpty)
    }

    @Test func percentEncodesPathSegments() throws {
        let (api, _) = makeAPI { _ in (200, Data()) }
        let url = try api.makeURL(APIRequest(path: ["api", "mobile", "comments", "a/b?c#d"]))
        #expect(url.absoluteString == "https://cap.so/api/mobile/comments/a%2Fb%3Fc%23d")
        #expect(throws: CapAPIError.badRequest) {
            try api.makeURL(APIRequest(path: ["api", "mobile", "comments", ".."]))
        }
        #expect(throws: CapAPIError.badRequest) {
            try api.makeURL(APIRequest(path: ["api", "", "x"]))
        }
    }

    @Test func dropsEmptyQueryItemsAndClampsPaging() async throws {
        let (api, transport) = makeAPI { _ in (200, try fixture("caps")) }
        _ = try await api.listCaps(folderId: nil, spaceId: "space_1", page: 0, limit: 500)
        let components = try #require(URLComponents(url: transport.requests[0].url!, resolvingAgainstBaseURL: false))
        var items: [String: String] = [:]
        for item in components.queryItems ?? [] { items[item.name] = item.value ?? "" }
        #expect(items == ["spaceId": "space_1", "page": "1", "limit": "50"])
    }

    @Test func reportsUnauthorizedWithTheCredentialsThatFailed() async {
        let calls = UnauthorizedLog()
        let (api, _) = makeAPI(unauthorized: calls) { _ in (401, Data()) }
        await #expect(throws: CapAPIError.unauthorized) {
            _ = try await api.bootstrap()
        }
        #expect(calls.entries == [testCredentials])
    }

    @Test func doesNotSignOutOnPublicUnauthorized() async {
        let calls = UnauthorizedLog()
        let (api, _) = makeAPI(unauthorized: calls) { _ in (401, Data()) }
        await #expect(throws: CapAPIError.unauthorized) {
            _ = try await api.authConfig()
        }
        #expect(calls.entries.isEmpty)
    }

    @Test func mapsStatusCodes() {
        #expect(CapAPIError.from(status: 204) == nil)
        #expect(CapAPIError.from(status: 403) == .forbidden)
        #expect(CapAPIError.from(status: 429) == .rateLimited)
        #expect(CapAPIError.from(status: 503) == .server(status: 503))
        #expect(CapAPIError.from(status: 302) == .unexpectedStatus(302))
        #expect(CapAPIError.from(URLError(.notConnectedToInternet)) == .offline)
        #expect(CapAPIError.from(CancellationError()) == .cancelled)
    }

    @Test func invalidJSONBecomesInvalidResponse() async {
        let (api, _) = makeAPI { _ in (200, Data("<html>".utf8)) }
        await #expect(throws: CapAPIError.invalidResponse) {
            _ = try await api.bootstrap()
        }
    }

    @Test func encodesExplicitNullsWhereTheContractRequiresThem() async throws {
        let user = #"{"id":"user_123","name":"R","lastName":null,"email":"r@cap.so","imageUrl":null,"activeOrganizationId":"org_1"}"#
        let summary = String(data: try fixture("cap-detail"), encoding: .utf8)!
        let capJSON = try JSONSerialization.data(withJSONObject: (try JSONSerialization.jsonObject(with: Data(summary.utf8)) as! [String: Any])["cap"]!)
        let settings = try fixture("org-settings")
        let comment = #"{"id":"c","videoId":"cap_1","type":"emoji","content":"👍","timestamp":null,"parentCommentId":null,"createdAt":"2026-10-28T11:00:00.000Z","updatedAt":"2026-10-28T11:00:00.000Z","author":{"id":"u","name":null,"imageUrl":null}}"#
        let (api, transport) = makeAPI { request in
            switch request.url?.path() {
            case "/api/mobile/user/profile": (200, Data(user.utf8))
            case "/api/mobile/caps/cap_1/password": (200, capJSON)
            case "/api/mobile/organization/settings": (200, settings)
            default: (200, Data(comment.utf8))
            }
        }
        let id = try #require(CapID("cap_1"))
        _ = try await api.updateProfile(name: "R", lastName: nil)
        _ = try await api.updatePassword(id, password: nil)
        _ = try await api.updateOrganizationSettings(name: "Cap", allowedEmailDomain: nil)
        _ = try await api.createReaction(id, emoji: "👍", timestamp: nil)
        _ = try await api.createComment(id, content: "Hi", timestamp: nil)

        let bodies: [[String: Any]] = try transport.requests.map { try bodyJSON($0) }
        #expect(bodies[0]["lastName"] is NSNull)
        #expect(bodies[1]["password"] is NSNull)
        #expect(bodies[2]["allowedEmailDomain"] is NSNull)
        #expect(bodies[3]["timestamp"] is NSNull)
        #expect(bodies[4]["timestamp"] is NSNull)
        #expect(bodies[4]["parentCommentId"] == nil)
        #expect(transport.requests.map { $0.httpMethod ?? "" } == ["PATCH", "PATCH", "PATCH", "POST", "POST"])
        #expect(transport.requests.allSatisfy { $0.value(forHTTPHeaderField: "Content-Type") == "application/json" })
    }

    @Test func emailRequestsNormalizeAddresses() async throws {
        let (api, transport) = makeAPI { request in
            if request.url?.path() == "/api/mobile/session/email/verify" {
                return (200, Data(#"{"type":"api_key","apiKey":"0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e","userId":"user_123"}"#.utf8))
            }
            return (200, Data(#"{"success":true}"#.utf8))
        }
        try await api.requestEmailCode(email: " Richie@Cap.so ")
        let session = try await api.verifyEmailCode(email: "Richie@Cap.so", code: "123456")
        #expect(session.userId == "user_123")
        let bodies: [[String: Any]] = try transport.requests.map { try bodyJSON($0) }
        #expect(bodies[0]["email"] as? String == "richie@cap.so")
        #expect(bodies[1]["code"] as? String == "123456")
        #expect(transport.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == nil })
    }

    @Test func registersAndRemovesPushTokens() async throws {
        let (api, transport) = makeAPI { _ in (200, Data(#"{"success":true}"#.utf8)) }
        try await api.registerPushToken("ab12", environment: .sandbox)
        try await api.removePushToken("ab12")
        let requests = transport.requests
        #expect(requests.map { $0.url?.path() ?? "" } == ["/api/mobile/user/push-tokens", "/api/mobile/user/push-tokens/remove"])
        #expect(requests.map { $0.httpMethod ?? "" } == ["POST", "POST"])
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer \(testCredentials.apiKey)" })
        let bodies: [[String: Any]] = try requests.map { try bodyJSON($0) }
        #expect(bodies[0]["token"] as? String == "ab12")
        #expect(bodies[0]["environment"] as? String == "sandbox")
        #expect(bodies[1]["token"] as? String == "ab12")
    }

    @Test func sharingSendsLinkAccessOnlyWhenChosen() async throws {
        let cap = #"{"id":"cap_1","shareUrl":"https://cap.so/s/cap_1","title":"Demo","createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-01T00:00:00.000Z","ownerName":"Owner","durationSeconds":null,"thumbnailUrl":null,"folderId":null,"public":true,"protected":false,"viewCount":0,"commentCount":0,"reactionCount":0,"upload":null,"linkAccess":"anyone"}"#
        let (api, transport) = makeAPI { _ in (200, Data(cap.utf8)) }
        let id = try #require(CapID("cap_1"))
        _ = try await api.updateSharing(id, isPublic: false)
        let opened = try await api.updateSharing(id, isPublic: true, linkAccess: .anyone)
        _ = try await api.updateSharing(id, isPublic: true, linkAccess: .restricted)
        let requests = transport.requests
        #expect(requests.allSatisfy { $0.url?.path() == "/api/mobile/caps/cap_1/sharing" && $0.httpMethod == "PATCH" })
        let bodies: [[String: Any]] = try requests.map { try bodyJSON($0) }
        #expect(bodies[0]["public"] as? Bool == false)
        #expect(bodies[0]["linkAccess"] == nil)
        #expect(bodies[0].count == 1)
        #expect(bodies[1]["public"] as? Bool == true)
        #expect(bodies[1]["linkAccess"] as? String == "anyone")
        #expect(bodies[2]["linkAccess"] as? String == "restricted")
        #expect(opened.linkAccess == .anyone)
    }

    @Test func rejectsImplausibleSessionsFromVerify() async {
        let (api, _) = makeAPI { _ in (200, Data(#"{"type":"api_key","apiKey":"x","userId":"user_123"}"#.utf8)) }
        await #expect(throws: CapAPIError.invalidResponse) {
            _ = try await api.verifyEmailCode(email: "r@cap.so", code: "123456")
        }
    }

    @Test func sessionRequestURLUsesFixedRedirect() throws {
        let (api, _) = makeAPI { _ in (200, Data()) }
        let url = api.sessionRequestURL(provider: "google")
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.host == "cap.so")
        #expect(components.path == "/api/mobile/session/request")
        #expect(components.queryItems?.first(where: { $0.name == "redirectUri" })?.value == "cap://auth")
        #expect(components.queryItems?.first(where: { $0.name == "provider" })?.value == "google")
        #expect(components.queryItems?.contains(where: { $0.name == "organizationId" }) == false)
    }

    @Test func authorizationHeaderOnlyForCapOrigin() {
        let (api, _) = makeAPI { _ in (200, Data()) }
        #expect(api.authorizationHeader(for: URL(string: "https://cap.so/api/mobile/caps/x/thumbnail")!) != nil)
        #expect(api.authorizationHeader(for: URL(string: "https://s3.amazonaws.com/x")!) == nil)
        #expect(api.authorizationHeader(for: URL(string: "http://cap.so/x")!) == nil)
    }

    @Test func capStatusesDedupesAndCaps() async throws {
        let (api, transport) = makeAPI { _ in (200, Data(#"{"caps":[]}"#.utf8)) }
        _ = try await api.capStatuses(ids: (0..<40).map { "cap_\($0 % 30)" })
        let ids = try #require(try bodyJSON(transport.requests[0])["ids"] as? [String])
        #expect(ids.count == 25)
        #expect(Set(ids).count == 25)
        _ = try await api.capStatuses(ids: [])
        #expect(transport.requests.count == 1)
    }
}

@Suite struct CredentialVaultTests {
    @Test func clearOnlyRemovesMatchingCredentials() throws {
        let store = InMemoryCredentialStore(testCredentials)
        let vault = CredentialVault(store: store)
        let newer = CredentialSnapshot(apiKey: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", userId: "user_123")
        try vault.replace(with: newer)
        #expect(vault.clear(ifMatching: testCredentials) == false)
        #expect(vault.credentials == newer)
        #expect(store.load() == newer)
        #expect(vault.clear(ifMatching: newer))
        #expect(vault.credentials == nil)
        #expect(store.load() == nil)
    }

    @Test func readsAgainAfterALockedKeychain() {
        let store = LockableStore(testCredentials)
        let vault = CredentialVault(store: store)
        #expect(vault.credentials == nil)
        store.unlock()
        #expect(vault.credentials == testCredentials)
    }

    @Test func aMissingSessionStaysSignedOut() {
        let store = LockableStore(nil)
        store.unlock()
        let vault = CredentialVault(store: store)
        #expect(vault.credentials == nil)
        try? store.save(testCredentials)
        #expect(vault.credentials == nil)
    }
}

private final class LockableStore: CredentialPersisting, @unchecked Sendable {
    private var stored: CredentialSnapshot?
    private var locked = true
    init(_ stored: CredentialSnapshot?) { self.stored = stored }
    func unlock() { locked = false }
    func load() -> CredentialSnapshot? { locked ? nil : stored }
    func read() -> CredentialRead { locked ? .locked : stored.map(CredentialRead.found) ?? .missing }
    func save(_ credentials: CredentialSnapshot) throws { stored = credentials }
    func delete() { stored = nil }
}
