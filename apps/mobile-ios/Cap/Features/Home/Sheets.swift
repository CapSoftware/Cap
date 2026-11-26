import CapKit
import SwiftUI

struct NewFolderSheet: View {
    let scope: LibraryScope
    @Environment(SessionModel.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var color: FolderColor = .normal
    @State private var isSaving = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Folder name", text: $name)
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit { Task { await save() } }
                        .onChange(of: name) { _, value in
                            if value.count > 100 { name = String(value.prefix(100)) }
                        }
                }
                Section("Color") {
                    HStack(spacing: 18) {
                        ForEach(FolderColor.allCases, id: \.self) { option in
                            Button {
                                color = option
                            } label: {
                                Image(systemName: "folder.fill")
                                    .font(.title2)
                                    .foregroundStyle(option == .normal ? Color.accentColor : option.tint)
                                    .padding(10)
                                    .background(
                                        Circle().strokeBorder(color == option ? Color.primary.opacity(0.4) : .clear, lineWidth: 2)
                                    )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(option.displayName)
                            .accessibilityAddTraits(color == option ? .isSelected : [])
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                if let error {
                    Section { ErrorText(error) }
                }
            }
            .navigationTitle("New folder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Create", systemImage: "checkmark") { Task { await save() } }
                            .disabled(trimmed.isEmpty)
                    }
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(isSaving)
    }

    private func save() async {
        guard !trimmed.isEmpty, !isSaving, let organizationId = session.organizationId else { return }
        isSaving = true
        error = nil
        defer { isSaving = false }
        do {
            let folder = try await session.api.createFolder(name: trimmed, color: color, spaceId: scope.spaceId)
            session.folderCreated(folder, in: LibraryKey(organizationId: organizationId, scope: scope, folderId: nil))
            session.toasts.show("Folder created", systemImage: "folder.fill")
            dismiss()
        } catch {
            self.error = error.errorDescription
        }
    }
}

struct OpenLinkSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://cap.so/s/…", text: $text)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focused)
                        .submitLabel(.go)
                        .onSubmit(open)
                    PasteButton(payloadType: String.self) { strings in
                        guard let value = strings.first else { return }
                        text = String(value.prefix(2048))
                        open()
                    }
                    .labelStyle(.titleAndIcon)
                } footer: {
                    Text("Paste a Cap share link to watch it here.")
                }
                if let error {
                    Section { ErrorText(error) }
                }
            }
            .navigationTitle("Open a Cap link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Open", systemImage: "arrow.right") { open() }
                        .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium])
    }

    private func open() {
        guard let id = ShareLinkParser.capID(fromUserInput: text) else {
            error = "That doesn't look like a Cap link."
            return
        }
        dismiss()
        app.pendingShareLink = ShareTarget(id: id)
    }
}

struct LoomImportSheet: View {
    @Environment(SessionModel.self) private var session
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""
    @State private var isImporting = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var normalized: URL? {
        guard let url = SafeURL.web(link.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host()?.lowercased(),
              host == "loom.com" || host.hasSuffix(".loom.com")
        else { return nil }
        return url
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://www.loom.com/share/…", text: $link)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focused)
                        .submitLabel(.go)
                        .onSubmit { Task { await startImport() } }
                    PasteButton(payloadType: String.self) { strings in
                        if let value = strings.first { link = String(value.prefix(2048)) }
                    }
                    .labelStyle(.titleAndIcon)
                } header: {
                    Text("Loom share link")
                } footer: {
                    Text("Cap copies the video into your library. Loom import is available on Cap Pro.")
                }
                if let error {
                    Section { ErrorText(error) }
                }
            }
            .navigationTitle("Import from Loom")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isImporting {
                        ProgressView()
                    } else {
                        Button("Import", systemImage: "arrow.down") { Task { await startImport() } }
                            .disabled(normalized == nil)
                    }
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(isImporting)
    }

    private func startImport() async {
        guard let url = normalized, !isImporting else {
            error = "Enter a loom.com share link."
            return
        }
        isImporting = true
        error = nil
        defer { isImporting = false }
        do {
            let result = try await session.api.importLoom(url: url.absoluteString)
            Usage.track("loom_import_started")
            session.invalidateLibraries()
            if let key = session.currentLibraryKey {
                Task { await session.library(for: key).refresh() }
            }
            session.toasts.show("Importing from Loom", systemImage: "square.and.arrow.down")
            BackgroundUploadCoordinator.shared.trackImport(capId: result.id, title: "Loom import")
            dismiss()
            if let id = CapID(result.id) { app.pendingShareLink = ShareTarget(id: id) }
        } catch .forbidden {
            error = "Loom import requires Cap Pro."
        } catch .badRequest {
            error = "Cap couldn't import that link. Check the Loom video is shared publicly and isn't already in this organization, then try again in a minute."
        } catch {
            self.error = error.errorDescription
        }
    }
}
