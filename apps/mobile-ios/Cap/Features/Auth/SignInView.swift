import AuthenticationServices
import CapKit
import SwiftUI

struct SignInView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var model: SignInModel?

    var body: some View {
        ZStack {
            Color(.systemBackground)
                .ignoresSafeArea()

            if let model {
                content(model)
            }
        }
        .task {
            if model == nil { model = SignInModel(api: app.services.api) }
            await model?.loadConfig()
        }
        .inAppSafari()
    }

    @ViewBuilder
    private func content(_ model: SignInModel) -> some View {
        VStack(spacing: 0) {
            SignInHero()
                .frame(maxWidth: .infinity, minHeight: 96, maxHeight: 300)

            VStack(spacing: 28) {
                header(model)

                Group {
                    switch model.step {
                    case .start:
                        StartPanel(model: model) { provider in
                            Task { await signIn(model, provider: provider) }
                        }
                        .transition(.asymmetric(insertion: .move(edge: .leading).combined(with: .opacity), removal: .move(edge: .leading).combined(with: .opacity)))
                    case let .code(email):
                        CodePanel(model: model, email: email) {
                            Task { await verify(model) }
                        }
                        .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .move(edge: .trailing).combined(with: .opacity)))
                    }
                }
                .animation(.spring(duration: 0.4, bounce: 0.15), value: model.step)
            }
            .padding(.horizontal, 24)
            .layoutPriority(1)

            Spacer(minLength: 16)

            legal
                .padding(.bottom, 8)
                .layoutPriority(1)
        }
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity)
    }

    private func header(_ model: SignInModel) -> some View {
        VStack(spacing: 8) {
            Text(model.step == .start ? "Sign in to Cap" : "Check your email")
                .font(.largeTitle.weight(.bold))
                .contentTransition(.opacity)
            Text(model.step == .start
                ? "Beautiful screen recordings, owned by you."
                : "We sent you a 6-digit sign in code.")
                .font(.body)
                .foregroundStyle(.secondary)
                .contentTransition(.opacity)
        }
        .multilineTextAlignment(.center)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var legal: some View {
        Text("By continuing you agree to Cap's [Terms](\(app.services.environment.termsURL.absoluteString)) and [Privacy Policy](\(app.services.environment.privacyURL.absoluteString)).")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 40)
            .tint(.primary)
    }

    private func signIn(_ model: SignInModel, provider: String) async {
        Usage.track("auth_started", ["method": .string(provider)])
        guard let session = await model.signIn(provider: provider, using: webAuthenticationSession) else { return }
        complete(session, model: model, method: provider)
    }

    private func verify(_ model: SignInModel) async {
        guard let session = await model.verify() else { return }
        complete(session, model: model, method: "email")
    }

    private func complete(_ session: APIKeySession, model: SignInModel, method: String) {
        do {
            try app.completeSignIn(session)
            Usage.track("user_signed_in", ["method": .string(method)])
        } catch {
            model.errorMessage = "Cap couldn't save your session securely. Try again."
        }
    }
}

private struct StartPanel: View {
    @Bindable var model: SignInModel
    let onProvider: (String) -> Void
    @Environment(AppModel.self) private var app
    @FocusState private var emailFocused: Bool
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 14) {
            if let notice = app.signedOutNotice, model.errorMessage == nil {
                ErrorText(notice)
            }

            TextField("you@company.com", text: $model.email)
                .textContentType(.username)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.continue)
                .focused($emailFocused)
                .onSubmit { Task { await model.sendCode() } }
                .padding(.horizontal, 18)
                .frame(height: 52)
                .background(Color(.secondarySystemBackground), in: .capsule)
                .overlay(Capsule().strokeBorder(emailFocused ? Color.primary.opacity(0.25) : .clear, lineWidth: 1))
                .animation(.snappy(duration: 0.15), value: emailFocused)
                .accessibilityLabel("Email address")

            Button {
                emailFocused = false
                Task { await model.sendCode() }
            } label: {
                HStack(spacing: 8) {
                    if model.activity == .email {
                        ProgressView().tint(Color(.systemBackground))
                    } else {
                        Image(systemName: "envelope.fill")
                    }
                    Text("Continue with email")
                }
            }
            .buttonStyle(InkButtonStyle())
            .disabled(!model.canSubmitEmail)

            if let error = model.errorMessage {
                ErrorText(error)
            }

            if model.config.appleAuthAvailable || model.config.googleAuthAvailable {
                HStack {
                    VStack { Divider() }
                    Text("or").font(.footnote).foregroundStyle(.secondary)
                    VStack { Divider() }
                }
                .padding(.vertical, 2)
                .accessibilityHidden(true)
            }

            if model.config.appleAuthAvailable {
                ProviderButton(title: "Continue with Apple", isLoading: model.activity == .provider("apple")) {
                    Image(systemName: "apple.logo")
                        .font(.system(size: 19, weight: .semibold))
                } action: { onProvider("apple") }
                .disabled(model.activity != nil)
            }

            if model.config.googleAuthAvailable {
                ProviderButton(title: "Continue with Google", isLoading: model.activity == .provider("google")) {
                    Image("GoogleLogo")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 18, height: 18)
                } action: { onProvider("google") }
                .disabled(model.activity != nil)
            }
        }
    }
}

private struct ProviderButton<Icon: View>: View {
    let title: String
    let isLoading: Bool
    @ViewBuilder let icon: () -> Icon
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if isLoading {
                    ProgressView()
                } else {
                    icon()
                }
                Text(title)
            }
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 50)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.capsule)
        .foregroundStyle(Color.primary)
        .accessibilityLabel(isLoading ? "\(title), loading" : title)
    }
}

private struct CodePanel: View {
    @Bindable var model: SignInModel
    let email: String
    let onVerify: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 16) {
            Text("Enter the code sent to **\(email)**")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)

            OneTimeCodeField(code: $model.code, isFocused: $focused)
                .disabled(model.activity == .verifying)
                .onChange(of: model.code) { _, newValue in
                    let sanitized = VerificationCode.sanitize(newValue)
                    if sanitized != newValue {
                        model.code = sanitized
                        return
                    }
                    if VerificationCode.isComplete(sanitized) { onVerify() }
                }

            if let error = model.errorMessage {
                ErrorText(error)
            }

            Button(action: onVerify) {
                HStack(spacing: 8) {
                    if model.activity == .verifying { ProgressView().tint(Color(.systemBackground)) }
                    Text("Verify and sign in")
                }
            }
            .buttonStyle(InkButtonStyle())
            .disabled(!VerificationCode.isComplete(model.code) || model.activity != nil)

            HStack {
                Button("Different email") { model.useDifferentEmail() }
                Spacer()
                ResendButton(model: model)
            }
            .font(.subheadline.weight(.semibold))
            .disabled(model.activity != nil)
        }
        .onAppear { focused = true }
    }
}

private struct ResendButton: View {
    let model: SignInModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let remaining = Int((model.resendAvailableAt ?? .distantPast).timeIntervalSince(context.date).rounded(.up))
            Button {
                Task { await model.resend() }
            } label: {
                if model.activity == .resending {
                    ProgressView()
                } else if remaining > 0 {
                    Text("Resend in \(remaining)s").monospacedDigit()
                } else {
                    Text("Resend code")
                }
            }
            .disabled(remaining > 0)
        }
    }
}

struct OneTimeCodeField: View {
    @Binding var code: String
    var isFocused: FocusState<Bool>.Binding

    var body: some View {
        ZStack {
            TextField("", text: $code)
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .focused(isFocused)
                .foregroundStyle(.clear)
                .tint(.clear)
                .accessibilityLabel("Verification code")
                .accessibilityValue(code.isEmpty ? "Empty" : code.map(String.init).joined(separator: " "))

            HStack(spacing: 8) {
                ForEach(0..<VerificationCode.length, id: \.self) { index in
                    let digit = index < code.count ? String(code[code.index(code.startIndex, offsetBy: index)]) : ""
                    let active = isFocused.wrappedValue && index == min(code.count, VerificationCode.length - 1)
                    Text(digit)
                        .font(.system(.title, design: .rounded, weight: .semibold))
                        .monospacedDigit()
                        .frame(maxWidth: .infinity, minHeight: 58)
                        .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 14))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14)
                                .strokeBorder(active ? Color.accentColor : .primary.opacity(0.08), lineWidth: active ? 2 : 1)
                        )
                        .animation(.snappy(duration: 0.15), value: active)
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .contentShape(.rect)
        .onTapGesture { isFocused.wrappedValue = true }
    }
}

struct ErrorText: View {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle.fill")
            .font(.footnote)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel("Error: \(message)")
    }
}

struct InkButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(Color(.systemBackground))
            .background(Color.primary, in: .capsule)
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.3)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
            .contentShape(.capsule)
    }
}
