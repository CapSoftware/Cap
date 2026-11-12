import CapKit
import SwiftUI
import UIKit

struct NotificationSettingsView: View {
    @Environment(SessionModel.self) private var session
    @Environment(\.openURL) private var openURL
    private let push = PushNotifications.shared
    @State private var preferences: NotificationPreferences?
    /// The last state the server confirmed, restored if a save fails and the server can't be re-read.
    @State private var confirmed: NotificationPreferences?
    @State private var loadError: CapAPIError?
    @State private var error: String?
    @State private var queue: [(NotificationPreferences.Kind, Bool)] = []
    @State private var isSaving = false

    private static let rows: [(kind: NotificationPreferences.Kind, title: String, detail: String)] = [
        (.comments, "Comments", "When someone comments on one of your Caps."),
        (.replies, "Replies", "When someone replies to a comment you left."),
        (.views, "Views", "When a signed-in viewer watches one of your Caps."),
        (.anonymousViews, "Anonymous views", "When an anonymous viewer watches one of your Caps."),
        (.reactions, "Reactions", "When someone reacts to one of your Caps."),
    ]

    var body: some View {
        Group {
            if let preferences {
                form(preferences)
            } else if let loadError {
                ContentUnavailableView {
                    Label("Notifications unavailable", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(loadError.errorDescription ?? "")
                } actions: {
                    Button("Try again") { Task { await load() } }
                        .buttonStyle(.glassProminent)
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func form(_ preferences: NotificationPreferences) -> some View {
        Form {
            Section {
                pushRow
            } header: {
                Text("On this iPhone")
            }
            Section {
                ForEach(Self.rows, id: \.kind) { row in
                    Toggle(isOn: Binding(
                        get: { preferences[row.kind] },
                        set: { enabled in Task { await set(row.kind, enabled: enabled) } }
                    )) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.title)
                            Text(row.detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } footer: {
                Text("These apply to push notifications on this iPhone, emails, and alerts on cap.so, and match your notification settings there.")
            }
            if let error {
                Section { ErrorText(error) }
            }
        }
        .readableWidth()
        .refreshable { await load() }
        .task { await push.refreshStatus() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            // Back from iOS Settings.
            Task { await push.registerIfAllowed() }
        }
    }

    @ViewBuilder
    private var pushRow: some View {
        switch push.status {
        case .notDetermined:
            Button {
                Task { await push.requestAuthorization() }
            } label: {
                Label("Turn on push notifications", systemImage: "bell.badge")
            }
        case .denied:
            Button {
                if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
            } label: {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Turn on in iOS Settings")
                        Text("Push notifications are off for Cap.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "bell.slash")
                }
            }
        default:
            Label("Push notifications are on", systemImage: "bell")
                .foregroundStyle(.secondary)
        }
    }

    private func load() async {
        do {
            let loaded = try await session.api.notificationPreferences()
            confirmed = loaded
            // Pull to refresh mid-save would otherwise show switches that are still being saved as reverted.
            if !isSaving { preferences = loaded }
            loadError = nil
        } catch {
            if preferences == nil { loadError = error }
        }
    }

    private func set(_ kind: NotificationPreferences.Kind, enabled: Bool) async {
        guard preferences != nil else { return }
        preferences?[kind] = enabled
        error = nil
        queue.append((kind, enabled))
        guard !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        // One request at a time, so each response includes every earlier change.
        while !queue.isEmpty {
            let (kind, enabled) = queue.removeFirst()
            do {
                let saved = try await session.api.setNotification(kind, enabled: enabled)
                confirmed = saved
                if queue.isEmpty { preferences = saved }
            } catch {
                queue.removeAll()
                self.error = error.errorDescription
                if let current = try? await session.api.notificationPreferences() {
                    confirmed = current
                }
                preferences = confirmed
            }
        }
    }
}
