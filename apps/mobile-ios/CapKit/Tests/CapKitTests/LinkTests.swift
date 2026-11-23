import Foundation
import Testing
@testable import CapKit

@Suite struct AuthCallbackTests {
    let key = "0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e"

    @Test func acceptsExactCallback() throws {
        let session = try AuthCallback.session(from: URL(string: "cap://auth?api_key=\(key)&user_id=user_123")!)
        #expect(session == APIKeySession(apiKey: key, userId: "user_123"))
    }

    @Test func surfacesProviderErrors() {
        #expect(throws: AuthCallbackError.provider("Access denied")) {
            try AuthCallback.session(from: URL(string: "cap://auth?error_description=Access%20denied")!)
        }
    }

    @Test(arguments: [
        "https://auth?api_key=0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e&user_id=user_123",
        "cap://evil?api_key=0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e&user_id=user_123",
        "cap://auth/extra?api_key=0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e&user_id=user_123",
        "cap://user@auth?api_key=0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e&user_id=user_123",
        "cap://auth:8080?api_key=0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e&user_id=user_123",
        "cap://auth?api_key=short&user_id=user_123",
        "cap://auth?api_key=0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e&user_id=../../etc",
        "cap://auth?api_key=0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e&api_key=0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7f&user_id=user_123",
        "cap://auth?user_id=user_123",
        "cap://auth",
    ])
    func rejectsMalformedCallbacks(_ raw: String) {
        #expect(throws: AuthCallbackError.invalidCallback) {
            try AuthCallback.session(from: URL(string: raw)!)
        }
    }
}

@Suite struct DeepLinkTests {
    @Test(arguments: [
        ("https://cap.so/s/abc123", "abc123"),
        ("https://www.cap.so/s/abc_123-x", "abc_123-x"),
        ("https://videos.acme.com/s/abc123", "abc123"),
        ("https://cap.so/s/abc123?t=12", "abc123"),
        ("cap://s/abc123", "abc123"),
    ])
    func parsesShareLinks(_ raw: String, _ expected: String) {
        guard case let .share(target)? = DeepLink.parse(URL(string: raw)!) else {
            Issue.record("Expected a share link for \(raw)")
            return
        }
        #expect(target.id.rawValue == expected)
    }

    @Test func parsesStopScreenRecording() {
        #expect(DeepLink.parse(DeepLink.stopScreenRecordingURL) == .stopScreenRecording)
        #expect(DeepLink.parse(URL(string: "cap://record")!) == nil)
        #expect(DeepLink.parse(URL(string: "cap://record/stop/now")!) == nil)
        #expect(DeepLink.parse(URL(string: "https://cap.so/record/stop")!) == nil)
    }

    @Test(arguments: [
        "http://cap.so/s/abc123",
        "https://cap.so/s/",
        "https://cap.so/s/abc/def",
        "https://cap.so/dashboard",
        "https://cap.so/s/abc%2F..",
        "https://user:pass@cap.so/s/abc123",
        "cap://s/abc/def",
        "cap://settings",
        "javascript://s/abc",
    ])
    func rejectsOtherLinks(_ raw: String) {
        let url = URL(string: raw)!
        if case .share? = DeepLink.parse(url) {
            Issue.record("Unexpected share link for \(raw)")
        }
    }

    @Test func parsesUserInput() {
        #expect(ShareLinkParser.capID(fromUserInput: "  https://cap.so/s/abc123  ")?.rawValue == "abc123")
        #expect(ShareLinkParser.capID(fromUserInput: "cap.so/s/abc123")?.rawValue == "abc123")
        #expect(ShareLinkParser.capID(fromUserInput: "abc123")?.rawValue == "abc123")
        #expect(ShareLinkParser.capID(fromUserInput: "not a link") == nil)
        #expect(ShareLinkParser.capID(fromUserInput: "https://loom.com/share/abc") == nil)
        #expect(ShareLinkParser.capID(fromUserInput: "") == nil)
    }

    @Test func capIDRejectsUnsafeCharacters() {
        #expect(CapID("abc") != nil)
        #expect(CapID("a/b") == nil)
        #expect(CapID("..") == nil)
        #expect(CapID("a b") == nil)
        #expect(CapID("ä") == nil)
        #expect(CapID(String(repeating: "a", count: 129)) == nil)
    }
}

@Suite struct EnvironmentTests {
    @Test func acceptsHTTPSOrigins() {
        #expect(CapEnvironment(string: "https://cap.so", allowInsecureLocalhost: false)?.baseURL.absoluteString == "https://cap.so")
        #expect(CapEnvironment(string: "https://CAP.so/", allowInsecureLocalhost: false)?.baseURL.absoluteString == "https://cap.so")
    }

    @Test func onlyAllowsHTTPForLocalDevelopment() {
        #expect(CapEnvironment(string: "http://cap.so", allowInsecureLocalhost: true) == nil)
        #expect(CapEnvironment(string: "http://localhost:3000", allowInsecureLocalhost: false) == nil)
        #expect(CapEnvironment(string: "http://localhost:3000", allowInsecureLocalhost: true)?.baseURL.port == 3000)
        #expect(CapEnvironment(string: "http://192.168.1.20:3000", allowInsecureLocalhost: true) != nil)
        #expect(CapEnvironment(string: "http://8.8.8.8:3000", allowInsecureLocalhost: true) == nil)
    }

    @Test func rejectsOriginsWithExtras() {
        #expect(CapEnvironment(string: "https://cap.so/api", allowInsecureLocalhost: false) == nil)
        #expect(CapEnvironment(string: "https://cap.so?x=1", allowInsecureLocalhost: false) == nil)
        #expect(CapEnvironment(string: "https://a:b@cap.so", allowInsecureLocalhost: false) == nil)
        #expect(CapEnvironment(string: "ftp://cap.so", allowInsecureLocalhost: true) == nil)
    }

    @Test func sameOriginComparesSchemeHostAndPort() {
        let env = CapEnvironment.production
        #expect(env.isSameOrigin(URL(string: "https://cap.so/api/x")!))
        #expect(env.isSameOrigin(URL(string: "https://cap.so:443/api/x")!))
        #expect(!env.isSameOrigin(URL(string: "http://cap.so/api/x")!))
        #expect(!env.isSameOrigin(URL(string: "https://cap.so.evil.com/api/x")!))
        #expect(!env.isSameOrigin(URL(string: "https://cdn.cap.so/x")!))
    }

    @Test func safeURLsRequireHTTPS() {
        #expect(SafeURL.web("https://cap.so/privacy") != nil)
        #expect(SafeURL.web("http://cap.so/privacy") == nil)
        #expect(SafeURL.web("javascript:alert(1)") == nil)
        #expect(SafeURL.media("/api/mobile/caps/x/thumbnail", environment: .production)?.absoluteString == "https://cap.so/api/mobile/caps/x/thumbnail")
        #expect(SafeURL.media("file:///etc/passwd", environment: .production) == nil)
    }

    @Test func validatesEmailsAndCodes() {
        #expect(EmailValidator.isValid(" Richie@Cap.so "))
        #expect(EmailValidator.normalize(" Richie@Cap.so ") == "richie@cap.so")
        #expect(!EmailValidator.isValid("richie@cap"))
        #expect(!EmailValidator.isValid("richie cap@cap.so"))
        #expect(!EmailValidator.isValid("@cap.so"))
        #expect(VerificationCode.sanitize("12a3 45-678") == "123456")
        #expect(VerificationCode.sanitize("١٢٣") == "")
        #expect(VerificationCode.isComplete("123456"))
        #expect(!VerificationCode.isComplete("12345"))
    }
}
