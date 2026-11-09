import CapKit
import SwiftUI

struct NotificationSettingsView: View {
    @Environment(SessionModel.self) private var session
    @State private var preferences: NotificationPreferences?
    @State private var loadError: CapAPIError?
    @State private var error: String?
    @State private var pending = 0

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
                Text("These apply to emails and alerts on cap.so, and match your notification settings there.")
            }
            if let error {
                Section { ErrorText(error) }
            }
        }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            preferences = try await session.api.notificationPreferences()
            loadError = nil
        } catch {
            if preferences == nil { loadError = error }
        }
    }

    private func set(_ kind: NotificationPreferences.Kind, enabled: Bool) async {
        guard let previous = preferences?[kind] else { return }
        preferences?[kind] = enabled
        error = nil
        pending += 1
        defer { pending -= 1 }
        do {
            let saved = try await session.api.setNotification(kind, enabled: enabled)
            // A later toggle may still be in flight; its response carries the newest state.
            if pending == 1 { preferences = saved }
        } catch {
            preferences?[kind] = previous
            self.error = error.errorDescription
        }
    }
}
