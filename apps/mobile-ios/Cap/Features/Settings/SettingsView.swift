import CapKit
import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(SessionModel.self) private var session
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var confirmingSignOut = false
    @State private var signingOut = false
    private let upgrade = WebUpgrade.shared

    private var version: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(short) (\(build))"
    }

    var body: some View {
        Form {
            Section {
                NavigationLink(value: Route.profile) {
                    HStack(spacing: 14) {
                        AvatarView(name: session.user?.displayName ?? "", imageURL: session.user?.imageUrl, size: 56)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(session.user?.displayName ?? "Your account")
                                .font(.title3.weight(.semibold))
                            Text(session.user?.email ?? " ")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .redacted(reason: session.user == nil ? .placeholder : [])
                    }
                    .padding(.vertical, 6)
                }
                planRow
                if let plan = session.plan, !plan.upgraded, upgrade.isAllowed {
                    Button {
                        // Safari rather than the in-app browser, so an existing cap.so sign-in carries over.
                        UIApplication.shared.open(app.services.environment.upgradeURL)
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Upgrade to Cap Pro")
                                Text("You can upgrade in your Cap dashboard")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: "arrow.up.forward.app")
                        }
                    }
                    .accessibilityLabel("Upgrade to Cap Pro")
                    .accessibilityHint("Opens your Cap dashboard in Safari")
                }
            }

            Section("Organization") {
                if let organizations = session.bootstrap?.organizations, organizations.count > 1 {
                    Picker(selection: Binding(
                        get: { session.organizationId ?? "" },
                        set: { id in
                            guard let organization = organizations.first(where: { $0.id == id }) else { return }
                            Task { await session.switchOrganization(to: organization) }
                        }
                    )) {
                        ForEach(organizations) { organization in
                            Text(organization.name).tag(organization.id)
                        }
                    } label: {
                        Label("Active organization", systemImage: "building.2")
                    }
                    .disabled(session.isSwitchingOrganization)
                } else if let organization = session.activeOrganization {
                    LabeledContent {
                        Text(organization.name)
                    } label: {
                        Label("Organization", systemImage: "building.2")
                    }
                }
                NavigationLink(value: Route.organization) {
                    Label("Organization settings", systemImage: "slider.horizontal.3")
                }
            }

            Section("App") {
                NavigationLink(value: Route.notifications) {
                    Label("Notifications", systemImage: "bell")
                }
                // A plain account link for every storefront: the dashboard's home, never billing, and nothing near the
                // plan's limit, so it isn't a call to buy outside the App Store (App Review 3.1.1(a)).
                Button {
                    UIApplication.shared.open(session.services.environment.dashboardURL)
                } label: {
                    Label("View the Cap dashboard", systemImage: "macwindow")
                }
                .foregroundStyle(.primary)
                .accessibilityHint("Opens cap.so in Safari")
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                } label: {
                    Label("Permissions", systemImage: "hand.raised")
                }
                .foregroundStyle(.primary)
                LabeledContent {
                    Text(version).monospacedDigit()
                } label: {
                    Label("Version", systemImage: "info.circle")
                }
            }

            Section("Help & Legal") {
                Link(destination: session.services.environment.supportURL) {
                    Label("Help & Support", systemImage: "questionmark.circle")
                }
                Link(destination: session.services.environment.privacyURL) {
                    Label("Privacy Policy", systemImage: "hand.raised.square")
                }
                Link(destination: session.services.environment.termsURL) {
                    Label("Terms of Service", systemImage: "doc.text")
                }
            }
            .foregroundStyle(.primary)

            Section {
                Button(role: .destructive) {
                    confirmingSignOut = true
                } label: {
                    HStack {
                        Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                        if signingOut {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(signingOut)
            }

            Section {
                NavigationLink(value: Route.deleteAccount) {
                    Label("Delete account", systemImage: "person.crop.circle.badge.xmark")
                        .foregroundStyle(.red)
                }
            }
        }
        .readableWidth()
        .navigationTitle("Settings")
        .toolbarTitleDisplayMode(.inlineLarge)
        .refreshable {
            async let bootstrap: Void = session.refreshBootstrap()
            async let plan: Void = session.refreshPlan()
            _ = await (bootstrap, plan)
        }
        .inAppSafari()
        .task { upgrade.start() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            // Back from upgrading on the web.
            if session.plan?.upgraded == false {
                Task { await session.refreshPlan() }
            }
        }
        .confirmationDialog("Sign out of Cap on this iPhone?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) {
                signingOut = true
                Task { await app.signOut() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if session.uploads.hasActiveUploads {
                Text("Uploads in progress will be cancelled.")
            }
        }
    }

    @ViewBuilder
    private var planRow: some View {
        LabeledContent {
            if let plan = session.plan {
                Text(plan.upgraded ? "Cap Pro" : "Free")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(plan.upgraded ? Color.accentColor : .secondary)
            } else if session.planError != nil {
                Button("Retry") { Task { await session.refreshPlan() } }
            } else {
                ProgressView()
            }
        } label: {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Plan")
                    if let plan = session.plan, !plan.upgraded {
                        Text("Recordings up to 5 minutes")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            } icon: {
                Image(systemName: "star.circle")
            }
        }
    }
}

struct ProfileSettingsView: View {
    @Environment(SessionModel.self) private var session
    @State private var firstName = ""
    @State private var lastName = ""
    @State private var loaded = false
    @State private var isSaving = false
    @State private var isUpdatingImage = false
    @State private var error: String?

    private var hasChanges: Bool {
        guard let user = session.user else { return false }
        return firstName.trimmingCharacters(in: .whitespaces) != (user.name ?? "")
            || lastName.trimmingCharacters(in: .whitespaces) != (user.lastName ?? "")
    }

    var body: some View {
        Form {
            Section {
                HStack {
                    Spacer()
                    ImagePickerControl(
                        title: "profile photo",
                        hasImage: session.user?.imageUrl != nil,
                        isWorking: isUpdatingImage,
                        onPick: updateImage,
                        onRemove: removeImage
                    ) {
                        AvatarView(name: session.user?.displayName ?? "", imageURL: session.user?.imageUrl, size: 96)
                    }
                    Spacer()
                }
                .listRowBackground(Color.clear)
            }

            Section("Name") {
                TextField("First name", text: $firstName)
                    .textContentType(.givenName)
                TextField("Last name (optional)", text: $lastName)
                    .textContentType(.familyName)
            }

            Section("Email") {
                Text(session.user?.email ?? "")
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            if let error {
                Section { ErrorText(error) }
            }
        }
        .readableWidth()
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if isSaving {
                    ProgressView()
                } else {
                    Button("Save") { Task { await save() } }
                        .disabled(!hasChanges || firstName.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .onChange(of: session.user, initial: true) { _, user in
            guard !loaded, let user else { return }
            firstName = user.name ?? ""
            lastName = user.lastName ?? ""
            loaded = true
        }
    }

    private func save() async {
        let first = firstName.trimmingCharacters(in: .whitespacesAndNewlines)
        let last = lastName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !first.isEmpty, first.count <= 255, last.count <= 255 else {
            error = "Enter a first name up to 255 characters."
            return
        }
        isSaving = true
        error = nil
        defer { isSaving = false }
        do {
            let user = try await session.api.updateProfile(name: first, lastName: last.isEmpty ? nil : last)
            session.updateUser(user)
            session.toasts.show("Profile updated", systemImage: "person.crop.circle.badge.checkmark")
        } catch {
            self.error = error.errorDescription
        }
    }

    private func updateImage(_ image: EncodedImage) async {
        isUpdatingImage = true
        defer { isUpdatingImage = false }
        do {
            session.updateUser(try await session.api.updateProfileImage(image))
            session.toasts.show("Photo updated", systemImage: "photo")
        } catch {
            session.toasts.show(error)
        }
    }

    private func removeImage() async {
        isUpdatingImage = true
        defer { isUpdatingImage = false }
        do {
            session.updateUser(try await session.api.removeProfileImage())
            session.toasts.show("Photo removed", systemImage: "photo")
        } catch {
            session.toasts.show(error)
        }
    }
}

struct DeleteAccountView: View {
    @Environment(SessionModel.self) private var session
    @Environment(AppModel.self) private var app
    @State private var confirmation = ""
    @State private var isDeleting = false
    @State private var confirming = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Image(systemName: "exclamationmark.octagon.fill")
                        .font(.largeTitle)
                        .foregroundStyle(.red)
                    Text("Permanently delete your account")
                        .font(.title3.bold())
                    Text("This removes your Cap account, your Caps, comments and analytics. Organizations you own are deleted for everyone in them. This can't be undone.")
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            }

            Section {
                TextField("Type DELETE to confirm", text: $confirmation)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
            } footer: {
                Text("Cap Support completes deletion requests and will email you when it's done.")
            }

            if let error {
                Section { ErrorText(error) }
            }

            Section {
                Button(role: .destructive) {
                    confirming = true
                } label: {
                    HStack {
                        Text("Request account deletion")
                        if isDeleting {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(confirmation != "DELETE" || isDeleting)
            }
        }
        .readableWidth()
        .navigationTitle("Delete account")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Delete your Cap account?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Delete account", role: .destructive) { Task { await delete() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You'll be signed out on this iPhone.")
        }
    }

    private func delete() async {
        isDeleting = true
        error = nil
        defer { isDeleting = false }
        do {
            try await session.api.requestAccountDeletion()
            await app.signOut()
        } catch {
            self.error = error.errorDescription
        }
    }
}
