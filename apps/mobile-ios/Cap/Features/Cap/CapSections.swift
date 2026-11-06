import CapKit
import SwiftUI
import UIKit

// MARK: Summary

struct SummarySection: View {
    let detail: CapDetail
    let model: CapDetailModel

    private var summary: String? {
        guard !detail.viewer.settings.disableSummary,
              let value = detail.summary?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty
        else { return nil }
        return value
    }

    private var chapters: [Chapter] {
        detail.viewer.settings.disableChapters ? [] : detail.chapters
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let summary {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Summary")
                        .font(.headline)
                    Text(LocalizedStringKey(summary))
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .capCardBackground()
            }

            if !chapters.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Chapters")
                        .font(.headline)
                        .padding(.bottom, 6)
                    ChapterList(chapters: chapters, model: model)
                }
            }

            if summary == nil, chapters.isEmpty {
                let generating = detail.viewer.isGeneratingAI || detail.transcriptionStatus == .processing || detail.cap.isProcessing
                ContentUnavailableView {
                    Label(generating ? "Generating summary" : "No summary yet", systemImage: generating ? "hourglass" : "text.alignleft")
                } description: {
                    Text(generating
                        ? "The summary and chapters appear here when they're ready."
                        : "Summaries and chapters appear for Caps with spoken audio.")
                } actions: {
                    if generating { ProgressView() }
                }
            }
        }
    }
}

private struct ChapterList: View {
    let chapters: [Chapter]
    let model: CapDetailModel

    var body: some View {
        let time = model.currentTime
        let active = chapters.lastIndex(where: { time >= $0.start && time > 0 })
        ForEach(Array(chapters.enumerated()), id: \.offset) { index, chapter in
            let isActive = index == active
            Button {
                model.seek(to: chapter.start)
            } label: {
                HStack(spacing: 12) {
                    Text(CapFormat.timestamp(chapter.start))
                        .font(.subheadline.monospacedDigit().weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                        .frame(minWidth: 52, alignment: .leading)
                    Text(chapter.title)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    if isActive {
                        Image(systemName: "waveform")
                            .foregroundStyle(Color.accentColor)
                            .symbolEffect(.variableColor.iterative, isActive: model.isPlaying)
                            .accessibilityHidden(true)
                    }
                }
                .padding(.vertical, 10)
                .padding(.horizontal, 12)
                .background(isActive ? Color.accentColor.opacity(0.1) : .clear, in: .rect(cornerRadius: 12))
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(chapter.title), at \(CapFormat.timestamp(chapter.start))")
            .accessibilityHint("Plays from this chapter")
            .accessibilityAddTraits(isActive ? .isSelected : [])
        }
    }
}

// MARK: Transcript

struct TranscriptSection: View {
    let model: CapDetailModel
    @State private var query = ""
    @Environment(SessionModel.self) private var session

    var body: some View {
        Group {
            switch model.transcript {
            case .idle, .loading:
                ProgressView("Loading transcript")
                    .frame(maxWidth: .infinity, minHeight: 160)
            case let .unavailable(message):
                ContentUnavailableView("No transcript", systemImage: "captions.bubble", description: Text(message))
            case let .loaded(cues):
                loaded(cues)
            }
        }
        .task { await model.loadTranscriptIfNeeded() }
    }

    private func loaded(_ cues: [TranscriptCue]) -> some View {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let visible = trimmed.isEmpty ? cues : cues.filter { $0.text.localizedStandardContains(trimmed) }
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    TextField("Search transcript", text: $query)
                        .submitLabel(.search)
                        .autocorrectionDisabled()
                    if !query.isEmpty {
                        Button("Clear search", systemImage: "xmark.circle.fill") { query = "" }
                            .labelStyle(.iconOnly)
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 32, minHeight: 32)
                            .contentShape(.rect)
                    }
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .glassEffect(.regular.interactive(), in: .capsule)

                Menu {
                    Button("Copy text", systemImage: "doc.on.doc") {
                        copy(TranscriptExport.plainText(cues), message: "Transcript copied")
                    }
                    Button("Copy with timestamps", systemImage: "clock") {
                        copy(TranscriptExport.timestamped(cues), message: "Transcript copied")
                    }
                    ShareLink(item: TranscriptExport.plainText(cues), subject: Text(model.cap?.title ?? "Transcript")) {
                        Label("Share transcript", systemImage: "square.and.arrow.up")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.headline)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("Transcript options")
            }

            if visible.isEmpty {
                ContentUnavailableView.search(text: trimmed)
            } else {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(visible) { cue in
                        TranscriptRow(cue: cue, isActive: model.activeCueID == cue.id) {
                            model.seek(to: cue.start)
                        }
                    }
                }
                .animation(.easeOut(duration: 0.2), value: model.activeCueID)
            }
        }
    }

    private func copy(_ text: String, message: String) {
        UIPasteboard.general.string = text
        session.toasts.show(message, systemImage: "doc.on.doc")
    }
}

private struct TranscriptRow: View {
    let cue: TranscriptCue
    let isActive: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(CapFormat.timestamp(cue.start))
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(isActive ? Color.accentColor : .secondary)
                    .frame(minWidth: 44, alignment: .leading)
                Text(cue.text)
                    .font(.body)
                    .foregroundStyle(isActive ? .primary : .secondary)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 10)
            .background(isActive ? Color.accentColor.opacity(0.1) : .clear, in: .rect(cornerRadius: 10))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Plays from \(CapFormat.timestamp(cue.start))")
    }
}

// MARK: Reactions

struct ReactionBar: View {
    let model: CapDetailModel
    @State private var taps = 0
    @ScaledMetric(relativeTo: .title2) private var emojiSize: CGFloat = 22

    var body: some View {
        GlassEffectContainer(spacing: 6) {
            HStack(spacing: 6) {
                ForEach(Reactions.emojis, id: \.self) { emoji in
                    Button {
                        taps += 1
                        Task { await model.react(emoji) }
                    } label: {
                        Text(emoji)
                            .font(.system(size: min(emojiSize, 30)))
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.capsule)
                    .accessibilityLabel("React with \(emoji)")
                    .accessibilityHint("Adds your reaction at the current moment")
                }
            }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: taps)
    }
}

// MARK: Comments

struct CommentsSection: View {
    let detail: CapDetail
    @Bindable var model: CapDetailModel

    private var threads: [CommentThread] {
        let built = model.threads
        switch model.commentOrder {
        case .oldest: return built
        case .newest: return built.reversed()
        case .video:
            return built.sorted { ($0.root.timestamp ?? .infinity, $0.root.createdAt) < ($1.root.timestamp ?? .infinity, $1.root.createdAt) }
        }
    }

    private var reactionCounts: [(emoji: String, count: Int, firstTime: Double?)] {
        var counts: [String: (Int, Double?)] = [:]
        for comment in detail.comments where comment.type == .emoji {
            let existing = counts[comment.content] ?? (0, nil)
            let first = [existing.1, comment.timestamp].compactMap { $0 }.min()
            counts[comment.content] = (existing.0 + 1, first)
        }
        return counts
            .map { (emoji: $0.key, count: $0.value.0, firstTime: $0.value.1) }
            .sorted { $0.count == $1.count ? $0.emoji < $1.emoji : $0.count > $1.count }
    }

    var body: some View {
        let threads = threads
        let total = threads.reduce(0) { $0 + 1 + $1.replies.count }
        VStack(alignment: .leading, spacing: 16) {
            if model.reactionsEnabled, !reactionCounts.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        ForEach(reactionCounts, id: \.emoji) { item in
                            Button {
                                if let time = item.firstTime { model.seek(to: time) }
                            } label: {
                                Text("\(item.emoji) \(CapFormat.count(item.count))")
                                    .font(.subheadline.monospacedDigit().weight(.medium))
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 6)
                                    .background(.quaternary, in: .capsule)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(item.count) \(item.emoji) reactions")
                            .accessibilityHint(item.firstTime == nil ? "" : "Plays from the first one")
                        }
                    }
                }
                .scrollIndicators(.hidden)
                .scrollClipDisabled()
            }

            if threads.isEmpty {
                ContentUnavailableView {
                    Label("Be the first to comment", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Comments are pinned to the moment you're watching, so everyone can jump straight to it.")
                }
                .padding(.vertical, 12)
            } else {
                HStack {
                    Text("\(CapFormat.count(total)) \(total == 1 ? "comment" : "comments")")
                        .font(.headline)
                    Spacer()
                    Menu {
                        Picker("Sort comments", selection: $model.commentOrder) {
                            ForEach(CapDetailModel.CommentOrder.allCases) { order in
                                Text(order.title).tag(order)
                            }
                        }
                    } label: {
                        Label(model.commentOrder.title, systemImage: "arrow.up.arrow.down")
                            .font(.subheadline.weight(.medium))
                    }
                    .accessibilityLabel("Sort comments, \(model.commentOrder.title)")
                }

                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(threads) { thread in
                        ThreadView(thread: thread, model: model)
                    }
                }
            }
        }
        .task(id: model.highlightedCommentID) {
            guard model.highlightedCommentID != nil else { return }
            try? await Task.sleep(for: .seconds(3))
            withAnimation(.easeOut(duration: 0.4)) { model.highlightedCommentID = nil }
        }
    }
}

private struct ThreadView: View {
    let thread: CommentThread
    let model: CapDetailModel
    @State private var expanded = false

    private static let collapsedReplies = 2

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            CommentRow(comment: thread.root, model: model, isReply: false)
            if !thread.replies.isEmpty {
                let showAll = expanded || thread.replies.count <= Self.collapsedReplies + 1 || thread.replies.contains { $0.id == model.highlightedCommentID }
                let visible = showAll ? thread.replies : Array(thread.replies.prefix(Self.collapsedReplies))
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(visible) { reply in
                        CommentRow(comment: reply, model: model, isReply: true)
                    }
                    if !showAll {
                        Button {
                            withAnimation(.snappy) { expanded = true }
                        } label: {
                            Label("Show \(thread.replies.count - visible.count) more \(thread.replies.count - visible.count == 1 ? "reply" : "replies")", systemImage: "chevron.down")
                                .font(.footnote.weight(.semibold))
                        }
                        .buttonStyle(.borderless)
                        .padding(.leading, 10)
                        .padding(.vertical, 4)
                    }
                }
                .padding(.leading, 22)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(.quaternary)
                        .frame(width: 2)
                        .padding(.leading, 26)
                        .padding(.vertical, 6)
                        .accessibilityHidden(true)
                }
                .padding(.leading, -10)
            }
        }
    }
}

private struct CommentRow: View {
    let comment: CapComment
    let model: CapDetailModel
    let isReply: Bool
    @Environment(SessionModel.self) private var session
    @State private var confirmingDelete = false

    private var isMine: Bool { comment.author.id == session.credentials.userId }
    private var isPending: Bool { model.pendingCommentIDs.contains(comment.id) }
    private var isHighlighted: Bool { model.highlightedCommentID == comment.id }
    private var isNowPlaying: Bool { model.nowPlayingCommentIDs.contains(comment.id) }
    private var authorName: String {
        let name = comment.author.name?.trimmingCharacters(in: .whitespaces) ?? ""
        return name.isEmpty ? "Anonymous" : name
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AvatarView(name: authorName, imageURL: comment.author.imageUrl, size: isReply ? 26 : 34)
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(authorName)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .layoutPriority(1)
                    Text(isPending ? "Sending…" : CapFormat.relative(comment.createdAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let timestamp = comment.timestamp, !isReply {
                        TimestampChip(time: timestamp, isActive: isNowPlaying) { model.seek(to: timestamp) }
                    }
                }
                LinkifiedText(comment.content)
                    .font(.body)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if model.commentsEnabled, !isPending {
                    Button("Reply") { model.startReply(to: comment) }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Reply to \(authorName)")
                }
            }
        }
        .padding(10)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(isHighlighted ? Color.accentColor.opacity(0.14) : isNowPlaying ? Color.accentColor.opacity(0.07) : .clear)
        }
        .opacity(isPending ? 0.55 : 1)
        .animation(.easeOut(duration: 0.25), value: isNowPlaying)
        .id(comment.id)
        .contextMenu {
            if !isPending {
                Button("Copy text", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = comment.content
                }
                if model.commentsEnabled {
                    Button("Reply", systemImage: "arrowshape.turn.up.left") { model.startReply(to: comment) }
                }
                if let timestamp = comment.timestamp {
                    Button("Play from \(CapFormat.timestamp(timestamp))", systemImage: "play") { model.seek(to: timestamp) }
                }
                if isMine {
                    Button("Delete", systemImage: "trash", role: .destructive) { confirmingDelete = true }
                }
            }
        }
        .confirmationDialog("Delete this comment?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await model.deleteComment(comment) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            if !isReply { Text("Replies to it will be hidden too.") }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Reply") { model.startReply(to: comment) }
    }
}

private struct TimestampChip: View {
    let time: Double
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(CapFormat.timestamp(time), systemImage: isActive ? "speaker.wave.2.fill" : "play.fill")
                .font(.caption.monospacedDigit().weight(.semibold))
                .labelStyle(ChipLabelStyle())
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .foregroundStyle(isActive ? Color.white : Color.accentColor)
                .background(isActive ? Color.accentColor : Color.accentColor.opacity(0.12), in: .capsule)
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Play from \(CapFormat.timestamp(time))")
    }
}

private struct ChipLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}

struct LinkifiedText: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(Self.attributed(text))
    }

    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// Makes web links tappable. Only http(s) links become links; nothing else is interpreted.
    static func attributed(_ text: String) -> AttributedString {
        var attributed = AttributedString(text)
        guard let detector, text.count < 20_000 else { return attributed }
        let range = NSRange(text.startIndex..., in: text)
        for match in detector.matches(in: text, range: range).prefix(50) {
            guard let url = match.url, let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
                  let stringRange = Range(match.range, in: text),
                  let attributedRange = Range(stringRange, in: attributed)
            else { continue }
            attributed[attributedRange].link = url
            attributed[attributedRange].underlineStyle = .single
        }
        return attributed
    }
}

struct CommentComposer: View {
    @Bindable var model: CapDetailModel
    let ownerName: String?
    @FocusState private var focused: Bool

    private var canSend: Bool {
        !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isSendingComment
    }

    private var placeholder: String {
        if let reply = model.replyingTo {
            return "Reply to \(reply.author.name?.split(separator: " ").first.map(String.init) ?? "comment")…"
        }
        if let ownerName, let first = ownerName.split(separator: " ").first {
            return "Respond to \(first)…"
        }
        return "Add a comment…"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let reply = model.replyingTo {
                HStack(spacing: 6) {
                    Image(systemName: "arrowshape.turn.up.left.fill")
                        .imageScale(.small)
                    Text("Replying to \(reply.author.name ?? "comment")")
                        .lineLimit(1)
                    Spacer()
                    Button("Cancel reply", systemImage: "xmark.circle.fill") { model.cancelReply() }
                        .labelStyle(.iconOnly)
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 32, minHeight: 32)
                        .contentShape(.rect)
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 20)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            GlassEffectContainer(spacing: 8) {
                HStack(alignment: .bottom, spacing: 8) {
                    HStack(alignment: .bottom, spacing: 8) {
                        if model.replyingTo == nil, !model.viewer.isScreenshot {
                            ComposerTimestampToggle(model: model, focused: focused)
                        }
                        TextField(placeholder, text: $model.draft, axis: .vertical)
                            .lineLimit(1...5)
                            .focused($focused)
                            .padding(.vertical, 3)
                            .onChange(of: model.draft) { _, value in
                                if value.count > 2000 { model.draft = String(value.prefix(2000)) }
                            }
                    }
                    .padding(.leading, model.replyingTo == nil && !model.viewer.isScreenshot ? 8 : 16)
                    .padding(.trailing, 16)
                    .padding(.vertical, 8)
                    .frame(minHeight: 44)
                    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))

                    Button {
                        focused = false
                        Task { await model.sendComment() }
                    } label: {
                        Group {
                            if model.isSendingComment {
                                ProgressView()
                            } else {
                                Image(systemName: "arrow.up")
                                    .font(.headline)
                            }
                        }
                        .frame(width: 30, height: 30)
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.circle)
                    .disabled(!canSend)
                    .accessibilityLabel(model.replyingTo == nil ? "Send comment" : "Send reply")
                }
            }
        }
        .padding(.horizontal, CapTheme.spacing)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .animation(.snappy(duration: 0.2), value: model.replyingTo?.id)
        .onChange(of: focused) { _, isFocused in
            if isFocused { model.beginComposing() }
        }
        .onChange(of: model.replyingTo?.id) { _, id in
            if id != nil { focused = true }
        }
    }
}

/// Shows the moment a comment is pinned to. Its own view so playback time only redraws the chip.
private struct ComposerTimestampToggle: View {
    @Bindable var model: CapDetailModel
    let focused: Bool

    var body: some View {
        Menu {
            if let time = model.feedbackTimestamp {
                Button("Pin to \(CapFormat.timestamp(time))", systemImage: "clock") { model.refreshComposerTimestamp() }
            }
            if model.composerTimestamp != nil {
                Button("Don't pin to a time", systemImage: "clock.badge.xmark") { model.composerTimestamp = nil }
            }
        } label: {
            Group {
                if let time = model.composerTimestamp ?? (focused ? nil : model.feedbackTimestamp) {
                    Text(CapFormat.timestamp(time))
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                        .padding(.horizontal, 8)
                        .frame(minWidth: 28, minHeight: 28)
                        .background(Color.accentColor.opacity(0.14), in: .capsule)
                } else {
                    Image(systemName: "clock")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                }
            }
            .contentTransition(.numericText())
        }
        .accessibilityLabel(model.composerTimestamp.map { "Pinned to \(CapFormat.timestamp($0))" } ?? "Not pinned to a time")
        .accessibilityHint("Changes the moment this comment is attached to")
    }
}
