import CapKit
import PhotosUI
import SwiftUI

struct OrganizationSettingsView: View {
    @Environment(SessionModel.self) private var session
    @State private var settings: OrganizationSettings?
    @State private var loadError: CapAPIError?
    @State private var name = ""
    @State private var domain = ""
    @State private var isSaving = false
    @State private var isUpdatingIcon = false
    @State private var error: String?

    private var normalizedDomain: String? {
        let value = domain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return value.isEmpty ? nil : value
    }

    private var hasChanges: Bool {
        guard let settings else { return false }
        return name.trimmingCharacters(in: .whitespacesAndNewlines) != settings.name || normalizedDomain != settings.allowedEmailDomain
    }

    private var domainIsValid: Bool {
        guard let normalizedDomain else { return true }
        return normalizedDomain.count <= 255 && EmailValidator.isValid("user@\(normalizedDomain)")
    }

    var body: some View {
        Group {
            if let settings {
                form(settings)
            } else if let loadError {
                ContentUnavailableView {
                    Label("Settings unavailable", systemImage: "exclamationmark.triangle")
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
        .navigationTitle("Organization")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func form(_ settings: OrganizationSettings) -> some View {
        Form {
            Section {
                HStack {
                    Spacer()
                    VStack(spacing: 10) {
                        if settings.canManage {
                            ImagePickerControl(
                                title: "organization icon",
                                hasImage: settings.iconUrl != nil,
                                isWorking: isUpdatingIcon,
                                onPick: updateIcon,
                                onRemove: removeIcon
                            ) {
                                OrganizationIcon(name: settings.name, iconURL: settings.iconUrl, size: 84)
                            }
                        } else {
                            OrganizationIcon(name: settings.name, iconURL: settings.iconUrl, size: 84)
                        }
                        Text(settings.role == .member ? "You're a member" : "You're an \(settings.role.displayName.lowercased())")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .listRowBackground(Color.clear)
            }

            Section {
                TextField("Organization name", text: $name)
                    .disabled(!settings.canManage)
            } header: {
                Text("Name")
            }

            Section {
                TextField("company.com", text: $domain)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(!settings.canManage)
            } header: {
                Text("Email access restriction")
            } footer: {
                Text(domainIsValid
                    ? "Only people with an email address at this domain can join. Leave empty to allow anyone you invite."
                    : "Enter a domain like company.com.")
                    .foregroundStyle(domainIsValid ? Color.secondary : .red)
            }

            Section("Custom domain") {
                if let customDomain = settings.customDomain {
                    HStack {
                        Text(customDomain)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 12)
                        Label(settings.domainVerified ? "Verified" : "Pending", systemImage: settings.domainVerified ? "checkmark.seal.fill" : "clock")
                            .foregroundStyle(settings.domainVerified ? .green : .orange)
                            .font(.subheadline.weight(.semibold))
                    }
                } else {
                    Text("No custom domain")
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                LabeledContent("Organization ID") {
                    Text(settings.id)
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            } footer: {
                if !settings.canManage {
                    Text("Only owners and admins can change organization settings.")
                } else {
                    Text("Manage members, billing and custom domains in Cap on the web.")
                }
            }

            if let error {
                Section { ErrorText(error) }
            }
        }
        .readableWidth()
        .toolbar {
            if settings.canManage {
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(!hasChanges || !domainIsValid || name.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
        .refreshable { await load() }
    }

    private func apply(_ settings: OrganizationSettings) {
        self.settings = settings
        name = settings.name
        domain = settings.allowedEmailDomain ?? ""
    }

    private func load() async {
        do {
            apply(try await session.api.organizationSettings())
            loadError = nil
        } catch {
            if settings == nil { loadError = error }
        }
    }

    private func save() async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 255, domainIsValid else { return }
        isSaving = true
        error = nil
        defer { isSaving = false }
        do {
            apply(try await session.api.updateOrganizationSettings(name: trimmed, allowedEmailDomain: normalizedDomain))
            await session.refreshBootstrap()
            session.toasts.show("Organization updated", systemImage: "building.2")
        } catch .forbidden {
            error = "Only organization owners and admins can make this change."
        } catch {
            self.error = error.errorDescription
        }
    }

    private func updateIcon(_ image: EncodedImage) async {
        isUpdatingIcon = true
        defer { isUpdatingIcon = false }
        do {
            apply(try await session.api.updateOrganizationIcon(image))
            await session.refreshBootstrap()
            session.toasts.show("Icon updated", systemImage: "photo")
        } catch {
            session.toasts.show(error)
        }
    }

    private func removeIcon() async {
        isUpdatingIcon = true
        defer { isUpdatingIcon = false }
        do {
            apply(try await session.api.removeOrganizationIcon())
            await session.refreshBootstrap()
            session.toasts.show("Icon removed", systemImage: "photo")
        } catch {
            session.toasts.show(error)
        }
    }
}

struct ImagePickerControl<Preview: View>: View {
    let title: String
    let hasImage: Bool
    let isWorking: Bool
    let onPick: (EncodedImage) async -> Void
    let onRemove: () async -> Void
    @ViewBuilder let preview: () -> Preview

    @Environment(SessionModel.self) private var session
    @State private var selection: PhotosPickerItem?
    @State private var showingPicker = false
    @State private var showingOptions = false

    var body: some View {
        Button {
            if hasImage { showingOptions = true } else { showingPicker = true }
        } label: {
            preview()
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: isWorking ? "hourglass" : "camera.fill")
                        .font(.footnote.weight(.semibold))
                        .padding(7)
                        .glassEffect(.regular, in: .circle)
                        .offset(x: 4, y: 4)
                }
                .overlay {
                    if isWorking {
                        ProgressView()
                            .padding(10)
                            .glassEffect(.regular, in: .circle)
                    }
                }
        }
        .buttonStyle(.plain)
        .disabled(isWorking)
        .accessibilityLabel("Change \(title)")
        .photosPicker(isPresented: $showingPicker, selection: $selection, matching: .images, preferredItemEncoding: .compatible)
        .confirmationDialog("Change \(title)", isPresented: $showingOptions) {
            Button("Choose photo") { showingPicker = true }
            Button("Remove photo", role: .destructive) { Task { await onRemove() } }
            Button("Cancel", role: .cancel) {}
        }
        .onChange(of: selection) { _, item in
            guard let item else { return }
            selection = nil
            Task {
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else { throw ImageCodingError.unreadable }
                    let encoded = try await Task.detached(priority: .userInitiated) {
                        try ImageCoding.encodeForUpload(data, fileName: "image.jpg")
                    }.value
                    await onPick(encoded)
                } catch {
                    session.toasts.show(error: error)
                }
            }
        }
    }
}
