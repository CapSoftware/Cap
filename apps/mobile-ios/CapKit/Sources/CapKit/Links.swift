import Foundation

public struct CapEnvironment: Sendable, Hashable {
    public let baseURL: URL

    public static let production = CapEnvironment(validatedBaseURL: URL(string: "https://cap.so")!)

    private init(validatedBaseURL: URL) {
        baseURL = validatedBaseURL
    }

    public init?(string: String, allowInsecureLocalhost: Bool) {
        guard
            let components = URLComponents(string: string.trimmingCharacters(in: .whitespacesAndNewlines)),
            let scheme = components.scheme?.lowercased(),
            let host = components.host?.lowercased(),
            !host.isEmpty,
            components.user == nil,
            components.password == nil,
            components.query == nil,
            components.fragment == nil,
            components.path.isEmpty || components.path == "/"
        else { return nil }

        switch scheme {
        case "https":
            break
        case "http" where allowInsecureLocalhost && CapEnvironment.isLocalDevelopmentHost(host):
            break
        default:
            return nil
        }

        var normalized = URLComponents()
        normalized.scheme = scheme
        normalized.host = host
        normalized.port = components.port
        guard let url = normalized.url else { return nil }
        baseURL = url
    }

    public static func isLocalDevelopmentHost(_ host: String) -> Bool {
        if host == "localhost" || host == "127.0.0.1" || host.hasSuffix(".local") { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else { return false }
        return parts[0] == 10 || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && (16...31).contains(parts[1]))
    }

    public func url(path: String) -> URL {
        baseURL.appending(path: path)
    }

    public func isSameOrigin(_ url: URL) -> Bool {
        url.scheme?.lowercased() == baseURL.scheme?.lowercased()
            && url.host()?.lowercased() == baseURL.host()?.lowercased()
            && (url.port ?? CapEnvironment.defaultPort(url.scheme)) == (baseURL.port ?? CapEnvironment.defaultPort(baseURL.scheme))
    }

    static func defaultPort(_ scheme: String?) -> Int? {
        switch scheme?.lowercased() {
        case "https": 443
        case "http": 80
        default: nil
        }
    }

    public var privacyURL: URL { url(path: "privacy") }
    public var termsURL: URL { url(path: "terms") }
    public var supportURL: URL { url(path: "docs") }
    public var dashboardURL: URL { url(path: "dashboard") }
    /// The dashboard's billing page, where a free plan upgrades. Signing in there keeps the purchase on the right account.
    public var upgradeURL: URL { url(path: "dashboard/settings/organization/billing") }

    public func shareURL(for capId: CapID) -> URL {
        baseURL.appending(path: "s").appending(path: capId.rawValue)
    }

    /// The share link that starts playback at `seconds`, like the share page's "Copy link at".
    public func shareURL(for capId: CapID, at seconds: Double) -> URL {
        let whole = Int(max(0, seconds.isFinite ? seconds : 0))
        guard whole > 0 else { return shareURL(for: capId) }
        return shareURL(for: capId).appending(queryItems: [URLQueryItem(name: "t", value: String(whole))])
    }
}

public struct CapID: Sendable, Hashable, Codable, CustomStringConvertible {
    public let rawValue: String

    public init?(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...128).contains(trimmed.utf8.count), trimmed.utf8.allSatisfy(CapID.isAllowed) else { return nil }
        rawValue = trimmed
    }

    private static func isAllowed(_ byte: UInt8) -> Bool {
        switch byte {
        case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "0")...UInt8(ascii: "9"):
            true
        case UInt8(ascii: "-"), UInt8(ascii: "_"):
            true
        default:
            false
        }
    }

    public var description: String { rawValue }
}

/// A Cap to open, optionally at a time or with a comment highlighted (from notification emails).
public struct ShareTarget: Sendable, Hashable {
    public let id: CapID
    public let startTime: Double?
    public let commentId: String?

    public init(id: CapID, startTime: Double? = nil, commentId: String? = nil) {
        self.id = id
        self.startTime = startTime
        self.commentId = commentId
    }

    static let maxStartTime: Double = 7 * 24 * 60 * 60

    init(id: CapID, query: [URLQueryItem]?) {
        func value(_ name: String) -> String? {
            query?.first(where: { $0.name == name })?.value
        }
        self.id = id
        if let raw = value("t"), let seconds = Double(raw), seconds.isFinite, seconds > 0, seconds <= Self.maxStartTime {
            startTime = seconds
        } else {
            startTime = nil
        }
        commentId = (value("comment") ?? value("reply")).flatMap(CapID.init)?.rawValue
    }
}

public enum DeepLink: Sendable, Hashable {
    case share(ShareTarget)
    case authCallback(URL)
    /// From the screen recording's Live Activity.
    case stopScreenRecording

    public static let stopScreenRecordingURL = URL(string: "cap://record/stop")!

    public static func parse(_ url: URL) -> DeepLink? {
        guard let scheme = url.scheme?.lowercased() else { return nil }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        if scheme == "cap" {
            let host = url.host()?.lowercased()
            if host == "auth" { return .authCallback(url) }
            if host == "record", url.pathComponents == ["/", "stop"] { return .stopScreenRecording }
            if host == "s", let id = url.pathComponents.dropFirst().first, url.pathComponents.count == 2, let capId = CapID(id) {
                return .share(ShareTarget(id: capId, query: query))
            }
            return nil
        }
        guard let capId = ShareLinkParser.capID(from: url) else { return nil }
        return .share(ShareTarget(id: capId, query: query))
    }
}

public enum ShareLinkParser {
    public static func capID(from url: URL) -> CapID? {
        guard url.scheme?.lowercased() == "https", url.host() != nil, url.user() == nil else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 2, parts[0] == "s" else { return nil }
        return CapID(parts[1])
    }

    public static func capID(fromUserInput input: String) -> CapID? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let url = URL(string: trimmed), url.scheme != nil {
            if case let .share(target)? = DeepLink.parse(url) { return target.id }
            return nil
        }
        if trimmed.contains("/"), let url = URL(string: "https://\(trimmed)") {
            return capID(from: url)
        }
        return CapID(trimmed)
    }
}

public enum AuthCallbackError: Error, Sendable, Equatable, LocalizedError {
    case provider(String)
    case invalidCallback

    public var errorDescription: String? {
        switch self {
        case let .provider(message): message
        case .invalidCallback: "Sign in did not return a Cap session. Try again."
        }
    }
}

public enum AuthCallback {
    public static let scheme = "cap"
    public static let redirectURI = "cap://auth"

    public static func session(from url: URL) throws(AuthCallbackError) -> APIKeySession {
        guard
            url.scheme?.lowercased() == scheme,
            url.host()?.lowercased() == "auth",
            url.user() == nil,
            url.port == nil,
            url.path().isEmpty || url.path() == "/",
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { throw .invalidCallback }

        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            let matches = items.filter { $0.name == name }
            guard matches.count == 1 else { return nil }
            return matches[0].value?.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        if let message = value("error_description"), !message.isEmpty {
            throw .provider(String(message.prefix(200)))
        }
        guard
            let apiKey = value("api_key"), APIKeyValidator.isPlausible(apiKey),
            let userId = value("user_id"), CapID(userId) != nil
        else { throw .invalidCallback }
        return APIKeySession(apiKey: apiKey, userId: userId)
    }
}

public enum APIKeyValidator {
    public static func isPlausible(_ key: String) -> Bool {
        (16...512).contains(key.utf8.count) && key.utf8.allSatisfy { $0 > 0x20 && $0 < 0x7F }
    }
}

public enum EmailValidator {
    public static func normalize(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    public static func isValid(_ email: String) -> Bool {
        let value = normalize(email)
        guard value.utf8.count <= 254, !value.contains(where: \.isWhitespace) else { return false }
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, parts[0].count <= 64 else { return false }
        let domain = parts[1]
        let labels = domain.split(separator: ".", omittingEmptySubsequences: false)
        return labels.count >= 2 && labels.allSatisfy { !$0.isEmpty && !$0.hasPrefix("-") && !$0.hasSuffix("-") }
    }
}

public enum VerificationCode {
    public static let length = 6

    public static func sanitize(_ input: String) -> String {
        String(input.filter(\.isASCII).filter(\.isNumber).prefix(length))
    }

    public static func isComplete(_ code: String) -> Bool {
        code.count == length && code.allSatisfy { $0.isASCII && $0.isNumber }
    }
}

public enum SafeURL {
    public static func web(_ string: String?) -> URL? {
        guard let string, let url = URL(string: string), url.scheme?.lowercased() == "https", url.host() != nil else { return nil }
        return url
    }

    public static func media(_ string: String?, environment: CapEnvironment) -> URL? {
        guard let string, let url = URL(string: string, relativeTo: environment.baseURL)?.absoluteURL, url.host() != nil else { return nil }
        switch url.scheme?.lowercased() {
        case "https":
            return url
        case "http" where environment.isSameOrigin(url):
            return url
        default:
            return nil
        }
    }
}
