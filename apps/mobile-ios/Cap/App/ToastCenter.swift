import CapKit
import Observation
import SwiftUI

struct Toast: Identifiable, Equatable {
    enum Style { case info, success, error }

    let id = UUID()
    let message: String
    let systemImage: String
    let style: Style
}

@MainActor
@Observable
final class ToastCenter {
    private(set) var current: Toast?
    @ObservationIgnored private var dismissTask: Task<Void, Never>?

    func show(_ message: String, systemImage: String = "checkmark.circle.fill", style: Toast.Style = .success) {
        let toast = Toast(message: message, systemImage: systemImage, style: style)
        withAnimation(.spring(duration: 0.35, bounce: 0.25)) { current = toast }
        dismissTask?.cancel()
        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(style == .error ? 4 : 2.4))
            guard !Task.isCancelled else { return }
            self?.dismiss(toast.id)
        }
    }

    func show(_ error: CapAPIError) {
        guard error != .cancelled else { return }
        show(error.errorDescription ?? "Something went wrong.", systemImage: "exclamationmark.triangle.fill", style: .error)
    }

    func show(error: any Error) {
        if let api = error as? CapAPIError {
            show(api)
        } else {
            show((error as? LocalizedError)?.errorDescription ?? "Something went wrong.", systemImage: "exclamationmark.triangle.fill", style: .error)
        }
    }

    func dismiss(_ id: UUID) {
        guard current?.id == id else { return }
        withAnimation(.easeOut(duration: 0.25)) { current = nil }
    }
}

struct ToastOverlay: ViewModifier {
    let center: ToastCenter

    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            if let toast = center.current {
                HStack(spacing: 10) {
                    Image(systemName: toast.systemImage)
                        .foregroundStyle(color(for: toast.style))
                        .font(.body.weight(.semibold))
                    Text(toast.message)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(3)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .glassEffect(.regular, in: .capsule)
                .padding(.horizontal, 24)
                .padding(.top, 6)
                .transition(.move(edge: .top).combined(with: .opacity))
                .onTapGesture { center.dismiss(toast.id) }
                .accessibilityAddTraits(.isStaticText)
                .onAppear {
                    AccessibilityNotification.Announcement(toast.message).post()
                }
                .sensoryFeedback(toast.style == .error ? .error : .success, trigger: toast.id)
            }
        }
    }

    private func color(for style: Toast.Style) -> Color {
        switch style {
        case .info: .accentColor
        case .success: .green
        case .error: .orange
        }
    }
}

extension View {
    func toasts(_ center: ToastCenter) -> some View {
        modifier(ToastOverlay(center: center))
    }
}
