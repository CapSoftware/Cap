import Foundation
import Synchronization

public enum CapAPIError: Error, Sendable, Equatable, LocalizedError {
    case unauthorized
    case forbidden
    case notFound
    case badRequest
    case conflict
    case payloadTooLarge
    case rateLimited
    case server(status: Int)
    case unexpectedStatus(Int)
    case offline
    case timedOut
    case cancelled
    case invalidResponse
    case transport(String)
    case missingSession

    public var errorDescription: String? {
        switch self {
        case .unauthorized, .missingSession: "Your session expired. Sign in again."
        case .forbidden: "You don't have access to this."
        case .notFound: "This couldn't be found. It may have been deleted or moved."
        case .badRequest: "Cap couldn't accept that. Check the details and try again."
        case .conflict: "This changed somewhere else. Refresh and try again."
        case .payloadTooLarge: "That file is too large."
        case .rateLimited: "Too many attempts. Wait a moment and try again."
        case .server: "Cap is having trouble right now. Try again shortly."
        case .unexpectedStatus: "Something went wrong. Try again."
        case .offline: "You're offline. Check your connection and try again."
        case .timedOut: "The request timed out. Try again."
        case .cancelled: "The request was cancelled."
        case .invalidResponse: "Cap sent an unexpected response. Update the app or try again."
        case .transport: "Couldn't reach Cap. Check your connection and try again."
        }
    }

    public var isRetryable: Bool {
        switch self {
        case .offline, .timedOut, .server, .transport, .rateLimited: true
        default: false
        }
    }

    public static func from(status: Int) -> CapAPIError? {
        switch status {
        case 200..<300: nil
        case 400, 422: .badRequest
        case 401: .unauthorized
        case 403: .forbidden
        case 404, 410: .notFound
        case 409: .conflict
        case 413: .payloadTooLarge
        case 429: .rateLimited
        case 500..<600: .server(status: status)
        default: .unexpectedStatus(status)
        }
    }

    public static func from(_ error: any Error) -> CapAPIError {
        if let error = error as? CapAPIError { return error }
        if error is CancellationError { return .cancelled }
        if error is DecodingError { return .invalidResponse }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cancelled: return .cancelled
            case .timedOut: return .timedOut
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
                return .offline
            case .badServerResponse, .cannotParseResponse, .cannotDecodeContentData, .cannotDecodeRawData:
                return .invalidResponse
            default:
                return .transport(urlError.code.rawValue.description)
            }
        }
        return .transport(String(describing: type(of: error)))
    }
}

public enum HTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"
}

public struct APIRequest: Sendable {
    public var method: HTTPMethod
    public var path: [String]
    public var query: [URLQueryItem]
    public var body: Data?
    public var authenticated: Bool
    public var videoAccess: CapID?

    public init(method: HTTPMethod = .get, path: [String], query: [URLQueryItem] = [], body: Data? = nil, authenticated: Bool = true, videoAccess: CapID? = nil) {
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.authenticated = authenticated
        self.videoAccess = videoAccess
    }
}

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public final class URLSessionTransport: NSObject, HTTPTransport, URLSessionTaskDelegate {
    private let session: URLSession

    public static func makeConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 120
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        configuration.httpMaximumConnectionsPerHost = 6
        configuration.waitsForConnectivity = false
        return configuration
    }

    public override init() {
        session = URLSession(configuration: Self.makeConfiguration())
        super.init()
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request, delegate: self)
        guard let http = response as? HTTPURLResponse else { throw CapAPIError.invalidResponse }
        return (data, http)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
        nil
    }
}

public struct CredentialSnapshot: Sendable, Equatable {
    public let apiKey: String
    public let userId: String

    public init(apiKey: String, userId: String) {
        self.apiKey = apiKey
        self.userId = userId
    }
}

public final class CapAPI: Sendable {
    public let environment: CapEnvironment
    private let transport: any HTTPTransport
    /// Password unlocks live in memory only, so they end with the process or sign out.
    private let videoAccessTokens = Mutex<[String: CapUnlock]>([:])
    private let credentials: @Sendable () -> CredentialSnapshot?
    private let onUnauthorized: @Sendable (CredentialSnapshot) -> Void
    private let userAgent: String

    public init(
        environment: CapEnvironment,
        transport: any HTTPTransport = URLSessionTransport(),
        userAgent: String = "Cap-iOS",
        credentials: @escaping @Sendable () -> CredentialSnapshot?,
        onUnauthorized: @escaping @Sendable (CredentialSnapshot) -> Void = { _ in }
    ) {
        self.environment = environment
        self.transport = transport
        self.credentials = credentials
        self.onUnauthorized = onUnauthorized
        self.userAgent = userAgent
    }

    static let pathAllowed: CharacterSet = {
        var set = CharacterSet()
        set.insert(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        return set
    }()

    func makeURL(_ request: APIRequest) throws -> URL {
        var components = URLComponents()
        components.scheme = environment.baseURL.scheme
        components.host = environment.baseURL.host()
        components.port = environment.baseURL.port
        var encodedPath = ""
        for segment in request.path {
            guard !segment.isEmpty, segment != ".", segment != "..",
                  let encoded = segment.addingPercentEncoding(withAllowedCharacters: Self.pathAllowed)
            else { throw CapAPIError.badRequest }
            encodedPath += "/" + encoded
        }
        components.percentEncodedPath = encodedPath
        let query = request.query.filter { ($0.value ?? "").isEmpty == false }
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw CapAPIError.badRequest }
        return url
    }

    func makeURLRequest(_ request: APIRequest) throws -> (URLRequest, CredentialSnapshot?) {
        var urlRequest = URLRequest(url: try makeURL(request))
        urlRequest.httpMethod = request.method.rawValue
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        var snapshot: CredentialSnapshot?
        if request.authenticated {
            guard let current = credentials() else { throw CapAPIError.missingSession }
            snapshot = current
            urlRequest.setValue("Bearer \(current.apiKey)", forHTTPHeaderField: "Authorization")
            if let id = request.videoAccess, let token = videoAccessToken(for: id) {
                urlRequest.setValue(token, forHTTPHeaderField: "X-Cap-Video-Access")
            }
        }
        if let body = request.body {
            urlRequest.httpBody = body
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return (urlRequest, snapshot)
    }

    public func send(_ request: APIRequest) async throws(CapAPIError) -> Data {
        let (urlRequest, snapshot): (URLRequest, CredentialSnapshot?)
        do {
            (urlRequest, snapshot) = try makeURLRequest(request)
        } catch {
            throw CapAPIError.from(error)
        }

        var attempt = 0
        while true {
            do {
                try Task.checkCancellation()
                let (data, response) = try await transport.send(urlRequest)
                if let error = CapAPIError.from(status: response.statusCode) {
                    if error == .unauthorized, let snapshot { onUnauthorized(snapshot) }
                    throw error
                }
                return data
            } catch {
                let mapped = CapAPIError.from(error)
                if request.method == .get, attempt == 0, (error as? URLError)?.code == .networkConnectionLost {
                    attempt += 1
                    continue
                }
                throw mapped
            }
        }
    }

    public func send<Response: Decodable>(_ request: APIRequest, as type: Response.Type = Response.self) async throws(CapAPIError) -> Response {
        let data = try await send(request)
        do {
            return try CapJSON.decoder().decode(Response.self, from: data)
        } catch {
            throw CapAPIError.invalidResponse
        }
    }

    func videoAccessToken(for id: CapID, now: Date = .now) -> String? {
        videoAccessTokens.withLock { tokens in
            guard let unlock = tokens[id.rawValue] else { return nil }
            guard unlock.expiresAt > now else {
                tokens[id.rawValue] = nil
                return nil
            }
            return unlock.accessToken
        }
    }

    public func hasVideoAccess(for id: CapID) -> Bool {
        videoAccessToken(for: id) != nil
    }

    public func clearVideoAccess() {
        videoAccessTokens.withLock { $0.removeAll() }
    }

    struct SharingBody: Encodable {
        let isPublic: Bool
        let linkAccess: LinkAccess?

        enum CodingKeys: String, CodingKey {
            case isPublic = "public"
            case linkAccess
        }
    }

    static func body(_ value: some Encodable) throws(CapAPIError) -> Data {
        do {
            return try CapJSON.encoder().encode(value)
        } catch {
            throw CapAPIError.badRequest
        }
    }
}

struct SuccessResponse: Decodable {
    let success: Bool
}

struct NullableBody<Value: Encodable>: Encodable {
    let fields: [(String, Value?)]

    struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        for (key, value) in fields {
            if let value {
                try container.encode(value, forKey: Key(stringValue: key))
            } else {
                try container.encodeNil(forKey: Key(stringValue: key))
            }
        }
    }
}

extension CapAPI {
    private static let mobile = ["api", "mobile"]

    private func mobile(_ method: HTTPMethod = .get, _ path: String..., query: [URLQueryItem] = [], body: Data? = nil, authenticated: Bool = true, access: CapID? = nil) -> APIRequest {
        APIRequest(method: method, path: Self.mobile + path, query: query, body: body, authenticated: authenticated, videoAccess: access)
    }

    private func expectSuccess(_ request: APIRequest) async throws(CapAPIError) {
        let response: SuccessResponse = try await send(request)
        guard response.success else { throw CapAPIError.invalidResponse }
    }

    public func authConfig() async throws(CapAPIError) -> AuthConfig {
        try await send(mobile(.get, "session", "config", authenticated: false))
    }

    public func requestEmailCode(email: String) async throws(CapAPIError) {
        let body = try Self.body(["email": EmailValidator.normalize(email)])
        try await expectSuccess(mobile(.post, "session", "email", "request", body: body, authenticated: false))
    }

    public func verifyEmailCode(email: String, code: String) async throws(CapAPIError) -> APIKeySession {
        let body = try Self.body(["email": EmailValidator.normalize(email), "code": code])
        let session: APIKeySession = try await send(mobile(.post, "session", "email", "verify", body: body, authenticated: false))
        guard APIKeyValidator.isPlausible(session.apiKey), CapID(session.userId) != nil else { throw CapAPIError.invalidResponse }
        return session
    }

    public func sessionRequestURL(provider: String) -> URL {
        var components = URLComponents(url: environment.url(path: "api/mobile/session/request"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "redirectUri", value: AuthCallback.redirectURI),
            URLQueryItem(name: "provider", value: provider),
        ]
        return components.url!
    }

    public func revokeSession() async throws(CapAPIError) {
        try await expectSuccess(mobile(.post, "session", "revoke"))
    }

    public func bootstrap() async throws(CapAPIError) -> Bootstrap {
        try await send(mobile(.get, "bootstrap"))
    }

    public func setActiveOrganization(_ organizationId: String) async throws(CapAPIError) -> Bootstrap {
        try await send(mobile(.patch, "user", "active-organization", body: Self.body(["organizationId": organizationId])))
    }

    public func updateProfile(name: String, lastName: String?) async throws(CapAPIError) -> CapUser {
        let body = try Self.body(NullableBody(fields: [("name", name), ("lastName", lastName)]))
        return try await send(mobile(.patch, "user", "profile", body: body))
    }

    public func updateProfileImage(_ image: EncodedImage) async throws(CapAPIError) -> CapUser {
        try await send(mobile(.put, "user", "profile", "image", body: Self.body(image.payload)))
    }

    public func removeProfileImage() async throws(CapAPIError) -> CapUser {
        try await send(mobile(.delete, "user", "profile", "image"))
    }

    public func requestAccountDeletion() async throws(CapAPIError) {
        try await expectSuccess(mobile(.post, "user", "account-deletion", body: Self.body(["confirmation": "DELETE"])))
    }

    public func blockUser(_ userId: String) async throws(CapAPIError) {
        try await expectSuccess(mobile(.post, "user", "blocks", body: Self.body(["userId": userId])))
    }

    public func notificationPreferences() async throws(CapAPIError) -> NotificationPreferences {
        try await send(mobile(.get, "user", "notification-preferences"))
    }

    public func setNotification(_ kind: NotificationPreferences.Kind, enabled: Bool) async throws(CapAPIError) -> NotificationPreferences {
        try await send(mobile(.patch, "user", "notification-preferences", body: Self.body([kind.rawValue: enabled])))
    }

    public func registerPushToken(_ token: String, environment: PushEnvironment) async throws(CapAPIError) {
        try await expectSuccess(mobile(.post, "user", "push-tokens", body: Self.body(["token": token, "environment": environment.rawValue])))
    }

    public func removePushToken(_ token: String) async throws(CapAPIError) {
        try await expectSuccess(mobile(.post, "user", "push-tokens", "remove", body: Self.body(["token": token])))
    }

    public func listCaps(folderId: String? = nil, spaceId: String? = nil, page: Int = 1, limit: Int = 30) async throws(CapAPIError) -> CapsPage {
        try await send(mobile(.get, "caps", query: [
            URLQueryItem(name: "folderId", value: folderId),
            URLQueryItem(name: "spaceId", value: spaceId),
            URLQueryItem(name: "page", value: String(max(1, page))),
            URLQueryItem(name: "limit", value: String(min(50, max(1, limit)))),
        ]))
    }

    public func capStatuses(ids: [String]) async throws(CapAPIError) -> [CapStatus] {
        let unique = Array(Set(ids)).sorted().prefix(25)
        guard !unique.isEmpty else { return [] }
        let response: CapStatusesResponse = try await send(mobile(.post, "caps", "statuses", body: Self.body(["ids": Array(unique)])))
        return response.caps
    }

    public func createFolder(name: String, color: FolderColor, spaceId: String?) async throws(CapAPIError) -> Folder {
        struct Body: Encodable {
            let name: String
            let color: FolderColor
            let spaceId: String?
        }
        return try await send(mobile(.post, "folders", body: Self.body(Body(name: name, color: color, spaceId: spaceId))))
    }

    public func cap(_ id: CapID) async throws(CapAPIError) -> CapDetail {
        try await send(mobile(.get, "caps", id.rawValue, access: id))
    }

    public func capAccess(_ id: CapID) async throws(CapAPIError) -> CapAccessStatus {
        let response: CapAccessResponse = try await send(mobile(.get, "caps", id.rawValue, "access", access: id))
        return response.status
    }

    public func unlockCap(_ id: CapID, password: String) async throws(CapAPIError) {
        let unlock: CapUnlock = try await send(mobile(.post, "caps", id.rawValue, "unlock", body: Self.body(["password": password])))
        guard !unlock.accessToken.isEmpty, unlock.accessToken.utf8.count <= 4096 else { throw CapAPIError.invalidResponse }
        videoAccessTokens.withLock { $0[id.rawValue] = unlock }
    }

    public func trackView(_ id: CapID, sessionId: String) async throws(CapAPIError) {
        try await expectSuccess(mobile(.post, "caps", id.rawValue, "views", body: Self.body(["sessionId": sessionId]), access: id))
    }

    public func reportCap(_ id: CapID, reason: ContentReportReason) async throws(CapAPIError) {
        try await expectSuccess(mobile(.post, "caps", id.rawValue, "report", body: Self.body(["reason": reason.rawValue]), access: id))
    }

    public func updateSharing(_ id: CapID, isPublic: Bool, linkAccess: LinkAccess? = nil) async throws(CapAPIError) -> CapSummary {
        try await send(mobile(.patch, "caps", id.rawValue, "sharing", body: Self.body(SharingBody(isPublic: isPublic, linkAccess: linkAccess))))
    }

    public func updateTitle(_ id: CapID, title: String) async throws(CapAPIError) -> CapSummary {
        try await send(mobile(.patch, "caps", id.rawValue, "title", body: Self.body(["title": title])))
    }

    public func updatePassword(_ id: CapID, password: String?) async throws(CapAPIError) -> CapSummary {
        try await send(mobile(.patch, "caps", id.rawValue, "password", body: Self.body(NullableBody(fields: [("password", password)]))))
    }

    public func deleteCap(_ id: CapID) async throws(CapAPIError) {
        try await expectSuccess(mobile(.delete, "caps", id.rawValue))
    }

    public func playback(_ id: CapID) async throws(CapAPIError) -> Playback {
        try await send(mobile(.get, "caps", id.rawValue, "playback", access: id))
    }

    public func download(_ id: CapID) async throws(CapAPIError) -> DownloadLink {
        try await send(mobile(.get, "caps", id.rawValue, "download", access: id))
    }

    public func capAnalytics(_ id: CapID, range: AnalyticsRange) async throws(CapAPIError) -> AnalyticsResponse {
        try await send(mobile(.get, "caps", id.rawValue, "analytics", query: [URLQueryItem(name: "range", value: range.rawValue)]))
    }

    public func organizationAnalytics(range: AnalyticsRange, spaceId: String? = nil) async throws(CapAPIError) -> AnalyticsResponse {
        try await send(mobile(.get, "analytics", query: [
            URLQueryItem(name: "range", value: range.rawValue),
            URLQueryItem(name: "spaceId", value: spaceId),
        ]))
    }

    public func organizationSettings() async throws(CapAPIError) -> OrganizationSettings {
        try await send(mobile(.get, "organization", "settings"))
    }

    public func updateOrganizationSettings(name: String, allowedEmailDomain: String?) async throws(CapAPIError) -> OrganizationSettings {
        let body = try Self.body(NullableBody(fields: [("name", name), ("allowedEmailDomain", allowedEmailDomain)]))
        return try await send(mobile(.patch, "organization", "settings", body: body))
    }

    public func updateOrganizationIcon(_ image: EncodedImage) async throws(CapAPIError) -> OrganizationSettings {
        try await send(mobile(.put, "organization", "settings", "icon", body: Self.body(image.payload)))
    }

    public func removeOrganizationIcon() async throws(CapAPIError) -> OrganizationSettings {
        try await send(mobile(.delete, "organization", "settings", "icon"))
    }

    public func importLoom(url: String) async throws(CapAPIError) -> LoomImportResult {
        try await send(mobile(.post, "imports", "loom", body: Self.body(["loomUrl": url])))
    }

    public func createComment(_ id: CapID, content: String, timestamp: Double?, parentCommentId: String? = nil) async throws(CapAPIError) -> CapComment {
        struct Body: Encodable {
            let content: String
            let timestamp: Double?
            let parentCommentId: String?

            func encode(to encoder: any Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(content, forKey: .content)
                try container.encode(timestamp, forKey: .timestamp)
                try container.encodeIfPresent(parentCommentId, forKey: .parentCommentId)
            }

            enum CodingKeys: String, CodingKey { case content, timestamp, parentCommentId }
        }
        let body = try Self.body(Body(content: content, timestamp: timestamp, parentCommentId: parentCommentId))
        return try await send(mobile(.post, "caps", id.rawValue, "comments", body: body, access: id))
    }

    public func deleteComment(_ commentId: String) async throws(CapAPIError) {
        try await expectSuccess(mobile(.delete, "comments", commentId))
    }

    public func createReaction(_ id: CapID, emoji: String, timestamp: Double?) async throws(CapAPIError) -> CapComment {
        let body = try Self.body(NullableBody(fields: [("content", AnyEncodable(emoji)), ("timestamp", timestamp.map(AnyEncodable.init))]))
        return try await send(mobile(.post, "caps", id.rawValue, "reactions", body: body, access: id))
    }

    public func createUpload(_ input: UploadRequest) async throws(CapAPIError) -> UploadCreated {
        try await send(mobile(.post, "uploads", body: Self.body(input)))
    }

    public func updateUploadProgress(_ id: CapID, uploaded: Int64, total: Int64) async throws(CapAPIError) {
        try await expectSuccess(mobile(.post, "uploads", id.rawValue, "progress", body: Self.body(["uploaded": uploaded, "total": total])))
    }

    public func completeUpload(_ id: CapID, rawFileKey: String, contentLength: Int64?) async throws(CapAPIError) {
        struct Body: Encodable {
            let rawFileKey: String
            let contentLength: Int64?
        }
        try await expectSuccess(mobile(.post, "uploads", id.rawValue, "complete", body: Self.body(Body(rawFileKey: rawFileKey, contentLength: contentLength))))
    }

    public func createRecording(fileName: String, format: RecordingJob.Format, organizationId: String?, folderId: String?) async throws(CapAPIError) -> RecordingCreated {
        struct Body: Encodable {
            let organizationId: String?
            let folderId: String?
            let fileName: String
            let width: Int
            let height: Int
            let fps: Int
        }
        let body = Body(organizationId: organizationId, folderId: folderId, fileName: fileName, width: format.width, height: format.height, fps: format.fps)
        return try await send(mobile(.post, "recordings", body: Self.body(body)))
    }

    public func recordingUploadTargets(_ id: CapID, subpaths: [String]) async throws(CapAPIError) -> [String: UploadTarget] {
        struct Response: Decodable { let uploads: [String: UploadTarget] }
        let response: Response = try await send(mobile(.post, "recordings", id.rawValue, "segments", "targets", body: Self.body(["subpaths": subpaths])))
        return response.uploads
    }

    public func completeRecording(_ id: CapID, _ completion: RecordingCompletion) async throws(CapAPIError) {
        try await expectSuccess(mobile(.post, "recordings", id.rawValue, "complete", body: Self.body(completion)))
    }

    public func plan() async throws(CapAPIError) -> PlanStatus {
        try await send(APIRequest(path: ["api", "desktop", "plan"]))
    }

    public func authorizationHeader(for url: URL) -> String? {
        guard environment.isSameOrigin(url), let credentials = credentials() else { return nil }
        return "Bearer \(credentials.apiKey)"
    }

    /// Nothing is sent to other origins, and the unlock only for that Cap's own thumbnail.
    public func mediaHeaders(for url: URL) -> [String: String] {
        guard let authorization = authorizationHeader(for: url) else { return [:] }
        var headers = ["Authorization": authorization]
        let parts = url.pathComponents.filter { $0 != "/" }
        if parts.count == 5, parts[0] == "api", parts[1] == "mobile", parts[2] == "caps", parts[4] == "thumbnail",
           let id = CapID(parts[3]), let token = videoAccessToken(for: id) {
            headers["X-Cap-Video-Access"] = token
        }
        return headers
    }
}

struct AnyEncodable: Encodable {
    private let encodeValue: (any Encoder) throws -> Void

    init(_ value: some Encodable) {
        encodeValue = { encoder in try value.encode(to: encoder) }
    }

    func encode(to encoder: any Encoder) throws {
        try encodeValue(encoder)
    }
}

public struct UploadRequest: Encodable, Sendable, Hashable {
    public let organizationId: String?
    public let folderId: String?
    public let fileName: String
    public let contentType: String
    public let contentLength: Int64?
    public let durationSeconds: Double?
    public let width: Int?
    public let height: Int?
    public let fps: Double?

    public init(organizationId: String?, folderId: String?, fileName: String, contentType: String, contentLength: Int64?, durationSeconds: Double?, width: Int?, height: Int?, fps: Double?) {
        self.organizationId = organizationId
        self.folderId = folderId
        self.fileName = fileName
        self.contentType = contentType
        self.contentLength = contentLength
        self.durationSeconds = durationSeconds
        self.width = width
        self.height = height
        self.fps = fps
    }
}
