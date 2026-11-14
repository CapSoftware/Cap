import CapKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct HomeView: View {
    @Environment(SessionModel.self) private var session

    var body: some View {
        Group {
            if let key = session.currentLibraryKey {
                LibraryContent(library: session.library(for: key), scope: session.scope, folderId: nil)
                    .id(key)
            } else if let error = session.bootstrapError {
                ContentUnavailableView {
                    Label("Couldn't load Cap", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(error.errorDescription ?? "")
                } actions: {
                    Button("Try again") { Task { await session.refreshBootstrap() } }
                        .buttonStyle(.glassProminent)
                }
            } else {
                LibrarySkeleton()
            }
        }
        .navigationTitle(session.scopeTitle)
        .toolbarTitleDisplayMode(.inlineLarge)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                AddMenu(folderId: nil)
            }
        }
        .safeAreaBar(edge: .top) {
            if session.showsScopeBar {
                ScopeBar()
            }
        }
    }
}

struct FolderView: View {
    let folder: Folder
    let scope: LibraryScope
    @Environment(SessionModel.self) private var session

    var body: some View {
        Group {
            if let organizationId = session.organizationId {
                let key = LibraryKey(organizationId: organizationId, scope: scope, folderId: folder.id)
                LibraryContent(library: session.library(for: key), scope: scope, folderId: folder.id)
            }
        }
        .navigationTitle(folder.name)
        .toolbarTitleDisplayMode(.inlineLarge)
        .toolbar {
            if scope == .personal {
                ToolbarItem(placement: .topBarTrailing) {
                    AddMenu(folderId: folder.id)
                }
            }
        }
    }
}

struct LibraryContent: View {
    let library: LibraryModel
    let scope: LibraryScope
    let folderId: String?

    @Environment(SessionModel.self) private var session
    @Environment(\.capSelection) private var selection
    @State private var pendingDelete: CapSummary?
    private let recent = RecentRecordings.shared

    private var recordingsInProgress: [RecentRecordings.Item] {
        recent.items.filter { $0.status != .ready }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: selection == nil ? 22 : 8) {
                if folderId == nil, !recordingsInProgress.isEmpty {
                    RecentRecordingsList(recent: recent, items: recordingsInProgress)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }

                if let job = session.uploads.visibleJob {
                    UploadBanner(job: job)
                }

                if folderId == nil, !library.folders.isEmpty {
                    FolderStrip(folders: library.folders, scope: scope)
                        .padding(.horizontal, -CapTheme.spacing)
                }

                if library.status == .loaded, library.caps.isEmpty {
                    emptyState
                } else if !library.caps.isEmpty {
                    if folderId == nil, !library.folders.isEmpty {
                        SectionHeader(title: "Caps", trailing: library.total > 0 ? CapFormat.count(library.total) : nil)
                    }
                    ForEach(library.caps) { cap in
                        if let capId = CapID(cap.id) {
                            Group {
                                if let selection {
                                    Button { selection.select(capId) } label: {
                                        CapRow(cap: cap, isSelected: selection.selected == capId)
                                    }
                                    .padding(.horizontal, -8)
                                    .accessibilityIdentifier("cap-row")
                                } else {
                                    NavigationLink(value: Route.cap(capId)) {
                                        CapCard(cap: cap)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .capContextMenu(cap: cap, pendingDelete: $pendingDelete)
                            .task { await library.loadMoreIfNeeded(after: cap) }
                        }
                    }
                    footer
                }
            }
            .padding(.horizontal, CapTheme.spacing)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .animation(.spring(duration: 0.35), value: recordingsInProgress)
        .overlay {
            switch library.status {
            case .loading where library.isEmpty:
                LibrarySkeleton()
            case let .failed(error) where library.isEmpty:
                ContentUnavailableView {
                    Label("Couldn't load Caps", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error.errorDescription ?? "")
                } actions: {
                    Button("Try again") { Task { await library.refresh() } }
                        .buttonStyle(.glassProminent)
                }
            default:
                EmptyView()
            }
        }
        .refreshable {
            async let caps: Void = library.refresh()
            async let bootstrap: Void = session.refreshBootstrap()
            _ = await (caps, bootstrap)
        }
        .task { await library.loadIfNeeded() }
        .capDeleteConfirmation(pendingDelete: $pendingDelete) { cap in
            if let selection, let id = CapID(cap.id) { selection.deselect(id) }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        ContentUnavailableView {
            Label(folderId == nil ? "No Caps yet" : "This folder is empty", systemImage: "play.rectangle.on.rectangle")
        } description: {
            Text(scope == .personal
                ? "Upload a video from Photos or Files, or import from Loom. Recordings from Cap for desktop show up here too."
                : "Caps shared to this space will appear here.")
        } actions: {
            if scope == .personal {
                AddMenu(folderId: folderId, style: .prominent)
            }
        }
        .padding(.top, 40)
    }

    @ViewBuilder
    private var footer: some View {
        if library.isLoadingMore {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding()
        } else if library.loadMoreError != nil {
            Button("Couldn't load more. Tap to retry.") {
                Task { await library.retryLoadMore() }
            }
            .font(.footnote)
            .frame(maxWidth: .infinity)
            .padding()
        }
    }
}

struct CapCard: View {
    let cap: CapSummary
    @Environment(SessionModel.self) private var session

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            CapThumbnail(cap: cap)
                .shadow(color: .black.opacity(0.08), radius: 10, y: 4)

            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(cap.title.isEmpty ? "Untitled" : cap.title)
                        .font(.headline)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .foregroundStyle(.primary)
                    HStack(spacing: 6) {
                        if !cap.isOwned(by: session.credentials.userId), !cap.ownerName.isEmpty {
                            Text(cap.ownerName)
                            Text("·")
                        }
                        Text(CapFormat.relative(cap.createdAt))
                        if cap.isOwned(by: session.credentials.userId) {
                            Image(systemName: cap.isPublic ? "globe" : "lock.fill")
                                .imageScale(.small)
                                .accessibilityLabel(cap.isPublic ? "Public" : "Private")
                        }
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
                Spacer(minLength: 8)
                HStack(spacing: 10) {
                    if cap.isOwned(by: session.credentials.userId) {
                        StatLabel(value: cap.viewCount, systemImage: "eye", accessibilityNoun: "views")
                    }
                    if cap.commentCount > 0 {
                        StatLabel(value: cap.commentCount, systemImage: "bubble.left", accessibilityNoun: "comments")
                    }
                    if cap.reactionCount > 0 {
                        StatLabel(value: cap.reactionCount, systemImage: "face.smiling", accessibilityNoun: "reactions")
                    }
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.top, 2)
            }
            .padding(.horizontal, 2)
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens this Cap")
    }
}

struct FolderStrip: View {
    let folders: [Folder]
    let scope: LibraryScope

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 10) {
                ForEach(folders) { folder in
                    NavigationLink(value: Route.folder(folder, scope)) {
                        HStack(spacing: 10) {
                            Image(systemName: "folder.fill")
                                .font(.title3)
                                .foregroundStyle(folder.color == .normal ? Color.accentColor : folder.color.tint)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(folder.name)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                Text(folder.videoCount == 1 ? "1 Cap" : "\(folder.videoCount) Caps")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .frame(minWidth: 132, alignment: .leading)
                        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 16))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(folder.name) folder, \(folder.videoCount) Caps")
                }
            }
            .padding(.horizontal, CapTheme.spacing)
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
    }
}

struct LibrarySkeleton: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                ForEach(0..<3, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: 10) {
                        RoundedRectangle(cornerRadius: CapTheme.thumbnailRadius, style: .continuous)
                            .fill(.quaternary)
                            .aspectRatio(16 / 9, contentMode: .fit)
                        Text("A placeholder Cap title")
                            .font(.headline)
                        Text("2 hours ago · 120 views")
                            .font(.subheadline)
                    }
                }
            }
            .padding(.horizontal, CapTheme.spacing)
            .redacted(reason: .placeholder)
            .shimmering()
        }
        .scrollDisabled(true)
        .accessibilityLabel("Loading Caps")
    }
}

private struct Shimmer: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    func body(content: Content) -> some View {
        content
            .opacity(dim ? 0.55 : 1)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
            }
    }
}

extension View {
    func shimmering() -> some View { modifier(Shimmer()) }
}

struct ScopeBar: View {
    @Environment(SessionModel.self) private var session
    @Environment(\.capSelection) private var selection

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                GlassEffectContainer(spacing: 8) {
                    HStack(spacing: 8) {
                        if let organizations = session.bootstrap?.organizations, organizations.count > 1 {
                            OrganizationChip(organizations: organizations)
                        }
                        ScopeChip(title: "My Caps", isSelected: session.scope == .personal) {
                            Image(systemName: "person.crop.circle")
                        } action: {
                            session.select(.personal)
                        }
                        .id(LibraryScope.personal)
                        ForEach(session.spaces) { space in
                            let scope = LibraryScope.space(id: space.id)
                            ScopeChip(title: space.name, isSelected: session.scope == scope) {
                                SpaceIcon(space: space)
                            } action: {
                                session.select(scope)
                            }
                            .id(scope)
                        }
                    }
                    .padding(.horizontal, CapTheme.spacing)
                    .padding(.vertical, 6)
                }
            }
            .scrollIndicators(.hidden)
            // The library column is narrow: scroll only as far as the selected scope needs, so the first chip stays whole.
            .onAppear { proxy.scrollTo(session.scope, anchor: selection == nil ? .center : nil) }
            .onChange(of: session.scope) { _, scope in
                withAnimation(.snappy) { proxy.scrollTo(scope, anchor: .center) }
            }
        }
    }
}

private struct ScopeChip<Icon: View>: View {
    let title: String
    let isSelected: Bool
    @ViewBuilder var icon: () -> Icon
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                icon()
                    .font(.subheadline)
                    .frame(width: 20, height: 20)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(isSelected ? Color.white : Color.primary)
            .padding(.horizontal, 12)
            .frame(height: 36)
            .frame(maxWidth: 220)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .glassEffect(isSelected ? .regular.tint(.accentColor).interactive() : .regular.interactive(), in: .capsule)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct SpaceIcon: View {
    let space: Space

    var body: some View {
        if space.kind == .organization {
            Image(systemName: "building.2")
        } else if space.iconUrl != nil {
            OrganizationIcon(name: space.name, iconURL: space.iconUrl, size: 20)
        } else {
            Image(systemName: space.privacy == .isPublic ? "person.3" : "lock")
        }
    }
}

private struct OrganizationChip: View {
    let organizations: [Organization]
    @Environment(SessionModel.self) private var session

    var body: some View {
        Menu {
            Section("Switch organization") {
                ForEach(organizations) { organization in
                    Button {
                        Task { await session.switchOrganization(to: organization) }
                    } label: {
                        if organization.id == session.organizationId {
                            Label(organization.name, systemImage: "checkmark")
                        } else {
                            Text(organization.name)
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                if session.isSwitchingOrganization {
                    ProgressView().controlSize(.small).frame(width: 20, height: 20)
                } else if let organization = session.activeOrganization {
                    OrganizationIcon(name: organization.name, iconURL: organization.iconUrl, size: 20)
                }
                Text(session.activeOrganization?.name ?? "Organization")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 12)
            .frame(height: 36)
            .frame(maxWidth: 200)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .capsule)
        .accessibilityLabel("Organization, \(session.activeOrganization?.name ?? "")")
        .accessibilityHint("Switch organization")
    }
}
