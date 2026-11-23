import AuthenticationServices
import CapKit
import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class SignInModel {
    enum Step: Equatable {
        case start
        case code(email: String)
    }

    enum Activity: Equatable {
        case email
        case verifying
        case resending
        case provider(String)
    }

    var step: Step = .start
    var email = ""
    var code = ""
    private(set) var activity: Activity?
    var errorMessage: String?
    private(set) var config: AuthConfig = .fallback
    private(set) var resendAvailableAt: Date?

    @ObservationIgnored private let api: CapAPI

    init(api: CapAPI) {
        self.api = api
    }

    var canSubmitEmail: Bool { EmailValidator.isValid(email) && activity == nil }

    func loadConfig() async {
        if let config = try? await api.authConfig() {
            self.config = config
        }
    }

    func sendCode() async {
        guard canSubmitEmail else {
            errorMessage = "Enter a valid email address."
            return
        }
        let normalized = EmailValidator.normalize(email)
        activity = .email
        errorMessage = nil
        defer { activity = nil }
        Usage.track("auth_started", ["method": "email"])
        do {
            try await api.requestEmailCode(email: normalized)
            Usage.track("auth_email_sent")
            code = ""
            resendAvailableAt = .now.addingTimeInterval(30)
            step = .code(email: normalized)
        } catch {
            errorMessage = message(for: error, context: .request)
        }
    }

    func resend() async {
        guard case let .code(email) = step, activity == nil else { return }
        if let resendAvailableAt, resendAvailableAt > .now { return }
        activity = .resending
        errorMessage = nil
        defer { activity = nil }
        do {
            try await api.requestEmailCode(email: email)
            code = ""
            resendAvailableAt = .now.addingTimeInterval(30)
        } catch {
            errorMessage = message(for: error, context: .request)
        }
    }

    func verify() async -> APIKeySession? {
        guard case let .code(email) = step, VerificationCode.isComplete(code), activity == nil else { return nil }
        activity = .verifying
        errorMessage = nil
        defer { activity = nil }
        do {
            return try await api.verifyEmailCode(email: email, code: code)
        } catch {
            code = ""
            resendAvailableAt = nil
            errorMessage = message(for: error, context: .verify)
            return nil
        }
    }

    func useDifferentEmail() {
        step = .start
        code = ""
        errorMessage = nil
    }

    func signIn(provider: String, using session: WebAuthenticationSession) async -> APIKeySession? {
        guard activity == nil else { return nil }
        activity = .provider(provider)
        errorMessage = nil
        defer { activity = nil }
        let url = api.sessionRequestURL(provider: provider)
        do {
            let callback = try await session.authenticate(
                using: url,
                callback: .customScheme(AuthCallback.scheme),
                preferredBrowserSession: .ephemeral,
                additionalHeaderFields: [:]
            )
            return try AuthCallback.session(from: callback)
        } catch let error as AuthCallbackError {
            errorMessage = error.errorDescription
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            return nil
        } catch {
            errorMessage = "Sign in couldn't start. Check your connection and try again."
        }
        return nil
    }

    private enum Context { case request, verify }

    private func message(for error: CapAPIError, context: Context) -> String {
        switch (error, context) {
        case (.rateLimited, _):
            return "Too many attempts. Wait a few minutes and try again."
        case (.forbidden, .verify), (.notFound, .verify), (.badRequest, .verify):
            return "That code didn't work. Codes can be used once and expire after a few minutes, so request a new one."
        case (.forbidden, .request):
            return "This email can't sign in with a code. Try another sign in option."
        case (.badRequest, .request):
            return "Enter a valid email address."
        default:
            return error.errorDescription ?? "Something went wrong. Try again."
        }
    }
}
