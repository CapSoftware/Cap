import CapKit
import SwiftUI

struct CapDetailView: View {
    let target: ShareTarget

    @Environment(SessionModel.self) private var session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.capsLayout) private var layout
    @Environment(\.capSelection) private var selection
    @Environment(CapDetailModels.self) private var capModels: CapDetailModels?
    @State private var model: CapDetailModel
    @State private var showingRename = false
    @State private var renameText = ""
    @State private var showingPassword = false
    @State private var showingReport = false
    @State private var showingBlock = false
    @State private var pendingDelete: CapSummary?
    @State private var showingFullscreen = false
    @State private var editor: EditorModel?
    @State private var showingProRequired = false
    @State private var openingEditor = false
    private let upgrade = WebUpgrade.shared

    init(model: CapDetailModel) {
        target = ShareTarget(id: model.id)
        _model = State(initialValue: model)
        _showingFullscreen = State(initialValue: model.isFullscreen)
    }

    typealias DetailSection = CapDetailModel.Section

    private var section: DetailSection {
        get { model.section }
        nonmutating set { model.section = newValue }
    }

    var body: some View {
        content
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(layout == .stack ? .hidden : .automatic, for: .tabBar)
            .task { await model.load(session: session) }
            .onAppear { model.presentations += 1 }
            .onDisappear {
                model.presentations -= 1
                // Folding or unfolding rebuilds this screen around the same model; only pause if nothing shows it now.
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(100))
                    if model.presentations == 0 { model.pauseForDisappear() }
                }
            }
            // Mirrored into view state: a binding straight into the model isn't observed by the presenter.
            .onChange(of: model.isFullscreen) { _, value in
                if showingFullscreen != value { showingFullscreen = value }
            }
            .onChange(of: showingFullscreen) { _, value in
                if model.isFullscreen != value { model.isFullscreen = value }
            }
            .onChange(of: isCovered) { _, covered in
                capModels?.setCovered(covered, by: model)
            }
            .fullScreenCover(isPresented: $showingFullscreen) {
                if let player = model.player {
                    FullscreenPlayer(model: model, player: player)
                }
            }
            .fullScreenCover(item: $editor) { editor in
                EditorView(model: editor) { outcome in
                    self.editor = nil
                    switch outcome {
                    case .cancelled:
                        break
                    case .saved:
                        session.toasts.show("Saving your edit. Your Cap updates in a moment.", systemImage: "scissors")
                        Task { await model.prepareForNewVersion() }
                    case .restored:
                        session.toasts.show("Restoring the original. Your Cap updates in a moment.", systemImage: "clock.arrow.circlepath")
                        Task { await model.prepareForNewVersion() }
                    }
                }
            }
            .alert("Editing is part of Cap Pro", isPresented: $showingProRequired) {
                if upgrade.isAllowed {
                    Button("Upgrade in your Cap dashboard") {
                        UIApplication.shared.open(session.services.environment.upgradeURL)
                    }
                }
                Button("OK", role: .cancel) {}
            } message: {
                Text("Trim, split and cut your Caps with Cap Pro.")
            }
            .task { upgrade.start() }
            #if DEBUG
            .task(id: model.cap?.id) {
                guard EditorDebug.openOnLoad, model.cap != nil, case let .loaded(detail) = model.content else { return }
                EditorDebug.openOnLoad = false
                // Like a person tapping Edit once the Cap has opened, give its video a moment to load.
                for _ in 0..<60 where !model.editorSourceReady {
                    try? await Task.sleep(for: .milliseconds(100))
                }
                try? await Task.sleep(for: .seconds(1))
                do {
                    let state = try await session.api.editState(target.id)
                    editor = EditorModel(capId: target.id, title: detail.cap.title, state: state, session: session, preloaded: model.editorSource)
                } catch {
                    // The edit endpoint isn't on this server yet: measure against the video as it is.
                    let state = CapEditState(status: .available, duration: detail.cap.durationSeconds ?? 0, hasEdits: false)
                    editor = EditorModel(capId: target.id, title: detail.cap.title, state: state, session: session, preloaded: model.editorSource)
                }
            }
            #endif
            .inAppSafari()
            .alert("Rename Cap", isPresented: $showingRename) {
                TextField("Title", text: $renameText)
                Button("Cancel", role: .cancel) {}
                Button("Save") { Task { await model.rename(to: renameText) } }
            }
            .sheet(isPresented: $showingPassword) {
                if let cap = model.cap {
                    PasswordSheet(isProtected: cap.isProtected) { password in
                        await model.setPassword(password)
                    }
                }
            }
            .confirmationDialog("Why are you reporting this Cap?", isPresented: $showingReport, titleVisibility: .visible) {
                ForEach(ContentReportReason.allCases) { reason in
                    Button(reason.title) { Task { _ = await model.report(reason) } }
                }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog("Block \(model.cap?.ownerName.isEmpty == false ? model.cap!.ownerName : "this user")?", isPresented: $showingBlock, titleVisibility: .visible) {
                Button("Block", role: .destructive) {
                    Task { if await model.blockOwner() { close() } }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You won't see their Caps or comments in Cap for iPhone.")
            }
            .capDeleteConfirmation(pendingDelete: $pendingDelete) { _ in close() }
    }

    private var isCovered: Bool {
        editor != nil || showingFullscreen
    }

    /// Beside the library the Cap is the detail column's root, which dismiss can't pop.
    private func close() {
        if let selection, selection.selected == model.id {
            selection.deselect(model.id)
        } else {
            dismiss()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.content {
        case .loading:
            loadingView
        case let .loaded(detail):
            loadedView(detail)
        case .locked:
            PasswordGateView(model: model)
        case .restricted:
            accessView(
                title: "You don't have access",
                message: "This Cap is private, limited to certain email addresses, or shared with an organization you're not in.",
                systemImage: "lock.fill"
            )
        case let .unavailable(error):
            if error == .notFound {
                accessView(title: "Cap not found", message: "It may have been deleted, or the link may be wrong.", systemImage: "questionmark.video")
            } else {
                ContentUnavailableView {
                    Label("Couldn't load this Cap", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(error.errorDescription ?? "")
                } actions: {
                    Button("Try again") { Task { await model.retry() } }
                        .buttonStyle(.glassProminent)
                }
            }
        }
    }

    private var loadingView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                RoundedRectangle(cornerRadius: CapTheme.thumbnailRadius, style: .continuous)
                    .fill(.quaternary)
                    .aspectRatio(16 / 9, contentMode: .fit)
                Text("Loading this Cap title")
                    .font(.title2.bold())
                Text("Owner name · 2 days ago")
            }
            .padding(CapTheme.spacing)
            .redacted(reason: .placeholder)
            .shimmering()
        }
        .scrollDisabled(true)
        .accessibilityLabel("Loading Cap")
    }

    private func accessView(title: String, message: String, systemImage: String) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
        } actions: {
            Link("Open in Safari", destination: session.services.environment.shareURL(for: target.id))
                .buttonStyle(.glassProminent)
        }
    }

    private func sections(_ detail: CapDetail) -> [DetailSection] {
        var result: [DetailSection] = []
        if model.commentsEnabled { result.append(.comments) }
        if model.summaryEnabled { result.append(.summary) }
        if model.transcriptEnabled { result.append(.transcript) }
        return result
    }

    private func loadedView(_ detail: CapDetail) -> some View {
        let owned = detail.cap.isOwned(by: session.credentials.userId)
        let available = sections(detail)
        let current = available.contains(section) ? section : available.first
        return VStack(spacing: 0) {
            PlayerStage(model: model, detail: detail)
                .padding(.horizontal, CapTheme.spacing)
                .padding(.top, 4)
                // A wide, short column would otherwise give the height to the scroll view and shrink the video.
                .layoutPriority(layout == .split ? 1 : 0)

            if model.player != nil, !model.playbackFailed, !detail.viewer.isScreenshot, (model.duration ?? 0) > 0 {
                PlayerTimeline(model: model, comments: detail.comments, chapters: detail.viewer.settings.disableChapters ? [] : detail.chapters) { marker in
                    model.seek(to: marker.time)
                    if model.commentsEnabled, let first = detail.comments.first(where: { marker.commentIds.contains($0.id) && $0.type == .text }) {
                        section = .comments
                        model.highlightedCommentID = first.id
                    }
                }
                .padding(.horizontal, CapTheme.spacing)
                .padding(.top, 2)
            }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18, pinnedViews: [.sectionHeaders]) {
                        CapHeader(detail: detail, owned: owned)
                            .padding(.horizontal, CapTheme.spacing)

                        if model.reactionsEnabled {
                            ReactionBar(model: model)
                                .padding(.horizontal, CapTheme.spacing)
                        }

                        Section {
                            Group {
                                switch current {
                                case .comments?:
                                    CommentsSection(detail: detail, model: model)
                                case .summary?:
                                    SummarySection(detail: detail, model: model)
                                case .transcript?:
                                    TranscriptSection(model: model)
                                case nil:
                                    EmptyView()
                                }
                            }
                            .padding(.horizontal, CapTheme.spacing)
                        } header: {
                            if available.count > 1, let current {
                                Picker("Section", selection: Binding(get: { current }, set: { section = $0 })) {
                                    ForEach(available, id: \.self) { item in
                                        Text(title(for: item, detail: detail)).tag(item)
                                    }
                                }
                                .pickerStyle(.segmented)
                                .padding(.horizontal, CapTheme.spacing)
                                .padding(.vertical, 8)
                                .background(Color(uiColor: .systemBackground).opacity(0.94))
                                .id("sections")
                            }
                        }
                    }
                    .padding(.top, 14)
                    .padding(.bottom, 24)
                    .animation(.snappy(duration: 0.25), value: section)
                }
                .scrollDismissesKeyboard(.interactively)
                .refreshable { await model.refreshDetail() }
                .onChange(of: model.highlightedCommentID, initial: true) { _, id in
                    guard let id else { return }
                    if model.commentsEnabled { section = .comments }
                    Task {
                        try? await Task.sleep(for: .milliseconds(120))
                        withAnimation(.snappy) { proxy.scrollTo(id, anchor: .center) }
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if current == .comments, model.commentsEnabled {
                CommentComposer(model: model, ownerName: owned ? nil : detail.cap.ownerName)
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let url = SafeURL.web(detail.shareUrl) {
                    ShareLink(item: url, subject: Text(detail.cap.title)) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                }
                moreMenu(detail, owned: owned)
            }
        }
    }

    private func copyLink(_ detail: CapDetail, at time: Double?) {
        if let time {
            UIPasteboard.general.url = session.services.environment.shareURL(for: target.id, at: time)
            session.toasts.show("Link at \(CapFormat.timestamp(time)) copied", systemImage: "link")
        } else {
            CapActions.copyLink(detail.shareUrl, session: session)
        }
    }

    private func openEditor(_ detail: CapDetail) {
        guard !openingEditor else { return }
        openingEditor = true
        model.pause()
        Task {
            defer { openingEditor = false }
            do {
                let state = try await session.api.editState(target.id)
                switch state.status {
                case .available:
                    editor = EditorModel(capId: target.id, title: detail.cap.title, state: state, session: session, preloaded: model.editorSource)
                case .proRequired:
                    showingProRequired = true
                case .busy:
                    session.toasts.show("An edit is already processing for this Cap. Try again when it's finished.", systemImage: "hourglass", style: .info)
                case .notEditable:
                    session.toasts.show("This Cap can't be edited until it has finished processing.", systemImage: "hourglass", style: .info)
                }
            } catch {
                session.toasts.show(error: error)
            }
        }
    }

    private func title(for section: DetailSection, detail: CapDetail) -> String {
        switch section {
        case .comments:
            let count = model.threadedCommentCount
            return count > 0 ? "Comments \(CapFormat.count(count))" : "Comments"
        case .summary: return "Summary"
        case .transcript: return "Transcript"
        }
    }

    private func moreMenu(_ detail: CapDetail, owned: Bool) -> some View {
        let cap = detail.cap
        return Menu {
            Section {
                Button("Copy link", systemImage: "link") { copyLink(detail, at: nil) }
                // Its own view, so playback time updates redraw this item and not the whole screen.
                CopyLinkAtTimeButton(model: model) { time in copyLink(detail, at: time) }
            }
            if owned {
                if !detail.viewer.isScreenshot {
                    Section {
                        Button("Edit", systemImage: "scissors") { openEditor(detail) }
                            .disabled(openingEditor || cap.isProcessing)
                    }
                }
                Section {
                    Button(cap.isPublic ? "Make private" : "Make public", systemImage: cap.isPublic ? "lock" : "globe") {
                        Task { await model.setPublic(!cap.isPublic) }
                    }
                    .disabled(model.updatingSharing)
                    if cap.isPublic, let linkAccess = cap.linkAccess {
                        Button(
                            linkAccess == .anyone ? "Limit to your organization" : "Open to anyone with the link",
                            systemImage: linkAccess == .anyone ? "person.2" : "link"
                        ) {
                            Task { await model.setLinkAccess(linkAccess == .anyone ? .restricted : .anyone) }
                        }
                        .disabled(model.updatingSharing)
                    }
                    Button("Rename", systemImage: "pencil") {
                        renameText = cap.title
                        showingRename = true
                    }
                    Button(cap.isProtected ? "Change password" : "Add password", systemImage: "key") {
                        showingPassword = true
                    }
                    NavigationLink(value: Route.capAnalytics(target.id, title: cap.title)) {
                        Label("Analytics", systemImage: "chart.xyaxis.line")
                    }
                }
            }
            if detail.viewer.canDownload, !detail.viewer.isScreenshot {
                Section {
                    Button("Save to Photos", systemImage: "square.and.arrow.down") {
                        Task { await model.saveToPhotos() }
                    }
                    .disabled(model.isSaving || cap.isProcessing)
                }
            }
            Section {
                if let url = SafeURL.web(cap.shareUrl) {
                    Link(destination: url) {
                        Label("Open in Safari", systemImage: "safari")
                    }
                }
            }
            if owned {
                Section {
                    Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = cap }
                }
            } else {
                Section {
                    Button("Report Cap", systemImage: "flag") { showingReport = true }
                    if cap.ownerId != nil {
                        Button("Block owner", systemImage: "hand.raised", role: .destructive) { showingBlock = true }
                    }
                }
            }
        } label: {
            Label("More", systemImage: "ellipsis")
        }
    }
}

private struct CopyLinkAtTimeButton: View {
    let model: CapDetailModel
    let action: (Double) -> Void

    var body: some View {
        if let time = model.feedbackTimestamp {
            Button("Copy link at \(CapFormat.timestamp(time))", systemImage: "clock") { action(time) }
        }
    }
}

// MARK: Player

struct PlayerStage: View {
    let model: CapDetailModel
    let detail: CapDetail
    @Environment(SessionModel.self) private var session

    var body: some View {
        ZStack {
            if detail.viewer.isScreenshot {
                CapThumbnail(cap: detail.cap, cornerRadius: 0, showsBadges: false)
            } else if detail.viewer.overShareLimit {
                CapThumbnail(cap: detail.cap, cornerRadius: 0, showsBadges: false)
                    .overlay {
                        notice(
                            systemImage: "link.badge.plus",
                            text: detail.cap.isOwned(by: detail.cap.ownerId ?? "") ? "This Cap is over your plan's monthly share limit." : "This Cap is over its free plan limit."
                        )
                    }
            } else if let player = model.player, !model.playbackFailed {
                CapPlayerSurface(model: model, player: player)
            } else {
                // The thumbnail draws its own processing and failure overlay when there's an upload.
                CapThumbnail(cap: detail.cap, cornerRadius: 0, showsBadges: false)
                    .overlay {
                        if detail.cap.upload == nil {
                            if model.playbackFailed {
                                notice(systemImage: "play.slash.fill", text: "This video can't play right now.")
                            } else {
                                ProgressView().tint(.white)
                            }
                        }
                    }
            }
            if model.player == nil || model.playbackFailed {
                BurstLayer(model: model)
            }
        }
        .aspectRatio(16 / 9, contentMode: .fit)
        .background(.black)
        .clipShape(.rect(cornerRadius: CapTheme.thumbnailRadius, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 16, y: 6)
    }

    private func notice(systemImage: String, text: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage).font(.title)
            Text(text)
                .font(.footnote.weight(.semibold))
                .multilineTextAlignment(.center)
        }
        .foregroundStyle(.white)
        .padding(16)
        .glassEffect(.regular.tint(.black.opacity(0.3)), in: .rect(cornerRadius: 18))
        .padding(16)
    }
}

// MARK: Moments

struct MarkerLayer: View {
    let comments: [CapComment]
    let duration: Double
    let width: CGFloat
    let onSelect: (TimelineMarker) -> Void

    private static let badgeSize: CGFloat = 26

    var body: some View {
        let coarse = TimelineMarkers.build(comments, duration: duration, buckets: max(6, Int(width / 30)))
        let total = coarse.reduce(0) { $0 + $1.count }
        let sparse = total <= max(6, Int(width / 34))
        let badges = sparse ? coarse : Self.peaks(in: coarse, width: width, limit: 3)
        ZStack(alignment: .leading) {
            if !sparse {
                DensityLayer(markers: TimelineMarkers.build(comments, duration: duration, buckets: max(20, Int(width / 5))), width: width)
            }
            ForEach(badges) { marker in
                Button { onSelect(marker) } label: {
                    MarkerBadge(marker: marker, showsCount: sparse)
                }
                .buttonStyle(.plain)
                .offset(x: min(max(width * marker.position - Self.badgeSize / 2, 0), max(width - Self.badgeSize, 0)))
                .accessibilityLabel(accessibilityLabel(marker))
                .accessibilityHint("Plays from this moment")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func peaks(in markers: [TimelineMarker], width: CGFloat, limit: Int) -> [TimelineMarker] {
        var chosen: [TimelineMarker] = []
        for marker in markers.sorted(by: { $0.count == $1.count ? $0.time < $1.time : $0.count > $1.count }) {
            guard chosen.count < limit else { break }
            let x = width * marker.position
            if chosen.allSatisfy({ abs(width * $0.position - x) > badgeSize + 6 }) {
                chosen.append(marker)
            }
        }
        return chosen.sorted { $0.time < $1.time }
    }

    private func accessibilityLabel(_ marker: TimelineMarker) -> String {
        var parts: [String] = []
        if marker.textCount > 0 { parts.append("\(marker.textCount) comment\(marker.textCount == 1 ? "" : "s")") }
        if marker.reactionCount > 0 { parts.append("\(marker.reactionCount) reaction\(marker.reactionCount == 1 ? "" : "s")") }
        return parts.joined(separator: " and ") + " at \(CapFormat.timestamp(marker.time))"
    }
}

private struct DensityLayer: View {
    let markers: [TimelineMarker]
    let width: CGFloat

    var body: some View {
        let peak = Double(markers.map(\.count).max() ?? 1)
        Canvas { context, size in
            let baseline = size.height / 2 - 4
            for marker in markers {
                let height = 3 + 11 * (Double(marker.count) / peak).squareRoot()
                let x = min(max(width * marker.position, 1), width - 1)
                let bar = CGRect(x: x - 1.25, y: baseline - height, width: 2.5, height: height)
                let color = marker.textCount > 0 ? Color.accentColor : Color.orange
                context.fill(Path(roundedRect: bar, cornerRadius: 1.25), with: .color(color.opacity(0.55)))
            }
        }
        .accessibilityHidden(true)
    }
}

private struct MarkerBadge: View {
    let marker: TimelineMarker
    var showsCount = true

    var body: some View {
        ZStack {
            if let emoji = marker.leadingEmoji {
                Text(emoji)
                    .font(.system(size: 15))
                    .frame(width: 26, height: 26)
                    .glassEffect(.regular, in: .circle)
            } else if let author = marker.authors.first {
                AvatarView(name: author.name ?? "Anonymous", imageURL: author.imageUrl, size: 24)
                    .padding(1)
                    .background(Color(uiColor: .systemBackground), in: .circle)
                    .frame(width: 26, height: 26)
            }
        }
        .overlay(alignment: .topTrailing) {
            if showsCount, marker.count > 1 {
                Text(marker.count > 99 ? "99+" : "\(marker.count)")
                    .font(.system(size: 9, weight: .bold).monospacedDigit())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 4)
                    .frame(minWidth: 15, minHeight: 15)
                    .background(Color.accentColor, in: .capsule)
                    .offset(x: 6, y: -5)
            }
        }
        .contentShape(.rect.inset(by: -8))
    }
}

// MARK: Header

private struct CapHeader: View {
    let detail: CapDetail
    let owned: Bool

    private var cap: CapSummary { detail.cap }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(cap.title.isEmpty ? "Untitled" : cap.title)
                .font(.title2.bold())
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                AvatarView(name: cap.ownerName, imageURL: detail.viewer.ownerImageUrl, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(cap.ownerName.isEmpty ? "Cap user" : cap.ownerName)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    HStack(spacing: 4) {
                        Text(CapFormat.relative(cap.createdAt))
                        Text("·")
                        Text("\(CapFormat.count(cap.viewCount)) \(cap.viewCount == 1 ? "view" : "views")")
                            .monospacedDigit()
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
                Spacer(minLength: 8)
                if owned {
                    Label(cap.isPublic ? "Public" : "Private", systemImage: cap.isPublic ? "globe" : "lock.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .labelStyle(.iconOnly)
                        .accessibilityLabel(cap.isPublic ? "Public" : "Private")
                }
            }
            .accessibilityElement(children: .combine)
            if let upload = cap.upload, cap.isProcessing {
                Label(upload.statusText, systemImage: "gearshape.2")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: Access

private struct PasswordGateView: View {
    @Bindable var model: CapDetailModel
    @State private var password = ""
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 76, height: 76)
                    .glassEffect(.regular, in: .circle)
                    .accessibilityHidden(true)
                VStack(spacing: 8) {
                    Text("This Cap is password protected")
                        .font(.title2.bold())
                        .multilineTextAlignment(.center)
                    Text("Enter the password the owner shared with you to watch it.")
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                VStack(spacing: 12) {
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .submitLabel(.go)
                        .focused($focused)
                        .onSubmit { Task { await model.unlock(password: password) } }
                        .padding(.horizontal, 16)
                        .frame(height: 52)
                        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: CapTheme.controlRadius + 2))
                    if let error = model.unlockError {
                        ErrorText(error)
                    }
                    Button {
                        Task { await model.unlock(password: password) }
                    } label: {
                        HStack(spacing: 8) {
                            if model.isUnlocking { ProgressView() }
                            Text("Watch Cap")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
                    .disabled(password.trimmingCharacters(in: .whitespaces).isEmpty || model.isUnlocking)
                }
            }
            .padding(24)
            .frame(maxWidth: 440)
            .frame(maxWidth: .infinity)
            .padding(.top, 40)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear { focused = true }
    }
}

struct PasswordSheet: View {
    let isProtected: Bool
    let onSave: (String?) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var isSaving = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField(isProtected ? "New password" : "Password", text: $password)
                        .textContentType(.newPassword)
                        .focused($focused)
                        .submitLabel(.done)
                } footer: {
                    Text("Viewers will need this password to watch. You and your organization can still open it in Cap.")
                }
                if isProtected {
                    Section {
                        Button("Remove password", role: .destructive) {
                            Task { await save(nil) }
                        }
                    }
                }
            }
            .navigationTitle(isProtected ? "Password" : "Add password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save", systemImage: "checkmark") { Task { await save(password) } }
                            .disabled(password.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(isSaving)
    }

    private func save(_ value: String?) async {
        isSaving = true
        defer { isSaving = false }
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        if await onSave(trimmed?.isEmpty == true ? nil : trimmed) { dismiss() }
    }
}
