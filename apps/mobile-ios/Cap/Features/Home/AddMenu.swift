import CapKit
import CoreTransferable
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct AddMenu: View {
    enum Style { case toolbar, prominent }

    let folderId: String?
    var style: Style = .toolbar

    @Environment(SessionModel.self) private var session
    @State private var showingPhotos = false
    @State private var showingFiles = false
    @State private var showingLoom = false
    @State private var showingFolder = false
    @State private var showingLink = false
    @State private var photoSelection: PhotosPickerItem?

    var body: some View {
        Menu {
            Section {
                Button("Record", systemImage: "record.circle") {
                    NotificationCenter.default.post(name: .capOpenRecorder, object: uploadFolderId)
                }
            }
            Section {
                Button("Upload from Photos", systemImage: "photo.on.rectangle") { showingPhotos = true }
                Button("Upload from Files", systemImage: "folder") { showingFiles = true }
                Button("Import from Loom", systemImage: "square.and.arrow.down.on.square") { showingLoom = true }
            }
            if folderId == nil, canCreateFolder {
                Section {
                    Button("New folder", systemImage: "folder.badge.plus") { showingFolder = true }
                }
            }
            Section {
                Button("Open a Cap link", systemImage: "link") { showingLink = true }
            }
        } label: {
            switch style {
            case .toolbar:
                Label("Add", systemImage: "plus")
            case .prominent:
                Label("Add a video", systemImage: "plus")
                    .font(.headline)
                    .padding(.horizontal, 6)
            }
        }
        .modifier(AddMenuStyle(style: style))
        .accessibilityLabel("Add")
        // `.current` hands over the original file. `.automatic` can make Photos transcode the video first, which is slow.
        .photosPicker(isPresented: $showingPhotos, selection: $photoSelection, matching: .any(of: [.videos, .images]), preferredItemEncoding: .current)
        .fileImporter(isPresented: $showingFiles, allowedContentTypes: [.movie, .video, .image], allowsMultipleSelection: false) { result in
            guard case let .success(urls) = result, let url = urls.first else { return }
            enqueueFile(url)
        }
        .onChange(of: photoSelection) { _, item in
            guard let item else { return }
            photoSelection = nil
            enqueuePhoto(item)
        }
        .sheet(isPresented: $showingLoom) { LoomImportSheet() }
        .sheet(isPresented: $showingFolder) { NewFolderSheet(scope: session.scope) }
        .sheet(isPresented: $showingLink) { OpenLinkSheet() }
    }

    private var canCreateFolder: Bool {
        switch session.scope {
        case .personal: true
        case .space: session.selectedSpace?.canManage ?? false
        }
    }

    private var uploadFolderId: String? {
        session.scope == .personal ? folderId : nil
    }

    private func enqueuePhoto(_ item: PhotosPickerItem) {
        let isImage = item.supportedContentTypes.contains { $0.conforms(to: .image) } && !item.supportedContentTypes.contains { $0.conforms(to: .movie) }
        Usage.track("upload_started", ["source": "photos", "kind": isImage ? "image" : "video"])
        session.uploads.enqueue(displayName: isImage ? "Photo" : "Video from Photos", folderId: uploadFolderId, kind: isImage ? .image : .video) {
            guard let media = try await item.loadTransferable(type: PickedMedia.self) else {
                throw UploadPreparationError.unreadable
            }
            return try await UploadCenter.prepareVideo(copying: media.url, suggestedName: media.suggestedName, securityScoped: false, moveInsteadOfCopy: true)
        }
    }

    private func enqueueFile(_ url: URL) {
        let isImage = UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) ?? false
        Usage.track("upload_started", ["source": "files", "kind": isImage ? "image" : "video"])
        session.uploads.enqueue(displayName: url.deletingPathExtension().lastPathComponent, folderId: uploadFolderId) {
            try await UploadCenter.prepareVideo(copying: url, suggestedName: nil, securityScoped: true)
        }
    }
}

private struct AddMenuStyle: ViewModifier {
    let style: AddMenu.Style

    func body(content: Content) -> some View {
        switch style {
        case .toolbar: content
        case .prominent: content.buttonStyle(.glassProminent)
        }
    }
}

struct PickedMedia: Transferable {
    let url: URL
    let suggestedName: String?

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in try stage(received.file) }
        FileRepresentation(importedContentType: .image) { received in try stage(received.file) }
    }

    private static func stage(_ file: URL) throws -> PickedMedia {
        let ext = file.pathExtension.isEmpty ? "mov" : file.pathExtension
        let destination = try UploadCenter.stagingURL(extension: ext)
        // Same volume, so APFS clones instead of copying bytes.
        try FileManager.default.copyItem(at: file, to: destination)
        let name = file.deletingPathExtension().lastPathComponent
        return PickedMedia(url: destination, suggestedName: name.isEmpty ? nil : name)
    }
}

struct UploadBanner: View {
    let job: UploadJob
    @Environment(SessionModel.self) private var session

    var body: some View {
        HStack(spacing: 14) {
            icon
                .frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if job.isActive {
                    ProgressView(value: job.fraction)
                        .progressViewStyle(.linear)
                        .tint(.accentColor)
                        .animation(.linear(duration: 0.2), value: job.fraction)
                }
            }
            Spacer(minLength: 0)
            trailing
        }
        .padding(14)
        .glassEffect(.regular, in: .rect(cornerRadius: 20))
        .accessibilityElement(children: .contain)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    @ViewBuilder
    private var icon: some View {
        switch job.phase {
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill").font(.title2).foregroundStyle(.orange)
        case .done:
            Image(systemName: "checkmark.circle.fill").font(.title2).foregroundStyle(.green)
        default:
            Image(systemName: "arrow.up.circle.fill").font(.title2).foregroundStyle(Color.accentColor)
                .symbolEffect(.pulse, isActive: job.isActive)
        }
    }

    private var title: String {
        switch job.phase {
        case .preparing: "Preparing video"
        case .uploading: "Uploading \(job.fileName)"
        case .finishing: "Finishing upload"
        case .done: "Uploaded"
        case .failed: "Upload failed"
        }
    }

    private var subtitle: String {
        switch job.phase {
        case .preparing: "Getting your video ready"
        case let .uploading(fraction): "\(Int((fraction * 100).rounded()))% · Keeps going if you leave Cap"
        case .finishing: "Almost done"
        case .done: "Your Cap is processing and the link is ready to share."
        case let .failed(message): message
        }
    }

    @ViewBuilder
    private var trailing: some View {
        switch job.phase {
        case let .done(shareURL, _):
            HStack(spacing: 8) {
                Button("Copy link", systemImage: "link") {
                    CapActions.copyLink(shareURL, session: session)
                    session.uploads.dismiss(job)
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.glass)
                dismissButton
            }
        case .failed:
            dismissButton
        case .uploading, .finishing:
            // The link works as soon as the Cap exists, so it can be shared before the upload ends.
            if let shareURL = job.shareURL {
                Button("Copy link", systemImage: "link") {
                    CapActions.copyLink(shareURL, session: session)
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.glass)
            }
        case .preparing:
            EmptyView()
        }
    }

    private var dismissButton: some View {
        Button("Dismiss", systemImage: "xmark") {
            withAnimation { session.uploads.dismiss(job) }
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.glass)
    }
}
