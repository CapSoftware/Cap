import AVFoundation
import AVKit
import CapKit
import Foundation
import Observation
import Photos

@MainActor
@Observable
final class CapDetailModel {
    enum Content {
        case loading
        case loaded(CapDetail)
        case locked
        case restricted
        case unavailable(CapAPIError)
    }

    enum TranscriptState {
        case idle
        case loading
        case loaded([TranscriptCue])
        case unavailable(String)
    }

    struct ReactionBurst: Identifiable, Equatable {
        let id = UUID()
        let emoji: String
        /// 0...1 across the player, so bursts don't stack on one spot.
        let lane: Double
    }

    enum CommentOrder: String, CaseIterable, Identifiable {
        case oldest, newest, video
        var id: Self { self }
        var title: String {
            switch self {
            case .oldest: "Oldest first"
            case .newest: "Newest first"
            case .video: "Video order"
            }
        }
    }

    enum Section: Hashable {
        case comments, summary, transcript
    }

    let id: CapID
    /// Lives here rather than in the view so folding or unfolding the phone keeps the open tab.
    var section: Section = .comments
    /// How many Cap screens show this model. The layout swap shows the new one before the old one goes.
    @ObservationIgnored var presentations = 0
    private(set) var content: Content = .loading {
        didSet { rebuildThreadsIfNeeded() }
    }
    /// Built once per comment change, not on every redraw.
    private(set) var threads: [CommentThread] = []
    private(set) var threadedCommentCount = 0
    private(set) var playbackFailed = false
    private(set) var player: AVPlayer?
    private(set) var currentTime: Double = 0
    private(set) var duration: Double?
    private(set) var videoAspect: Double = 16 / 9
    private(set) var isPlaying = false
    private(set) var isBuffering = false
    private(set) var hasEnded = false
    private(set) var rate: Float = 1.2
    private(set) var scrubTime: Double?
    private(set) var isScrubbing = false
    private(set) var controlsVisible = true
    private(set) var isPictureInPictureActive = false
    var isFullscreen = false
    var pictureInPicture: AVPictureInPictureController?
    private(set) var transcript: TranscriptState = .idle
    private(set) var activeCueID: Int?
    private(set) var activeCaption: String?
    private(set) var nowPlayingCommentIDs: Set<String> = []
    private(set) var bursts: [ReactionBurst] = []
    private(set) var pendingCommentIDs: Set<String> = []
    private(set) var isSendingComment = false
    private(set) var isSaving = false
    private(set) var isUnlocking = false
    var unlockError: String?
    var draft = ""
    var replyingTo: CapComment?
    /// Captured when composing starts so it doesn't drift.
    var composerTimestamp: Double?
    var highlightedCommentID: String?
    var commentOrder: CommentOrder = .oldest
    var captionsEnabled: Bool {
        didSet { UserDefaults.standard.set(captionsEnabled, forKey: Self.captionsKey) }
    }

    @ObservationIgnored private var playback: Playback?
    @ObservationIgnored private var awaitingNewVersion = false
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []
    @ObservationIgnored private weak var session: SessionModel?
    @ObservationIgnored private var pendingStartTime: Double?
    @ObservationIgnored private var lastBurstTime: Double = 0
    @ObservationIgnored private var trackedView = false
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var loading: Task<Void, Never>?
    @ObservationIgnored private var cues: [TranscriptCue] = []
    @ObservationIgnored private var endObserver: (any NSObjectProtocol)?
    @ObservationIgnored private var hideTask: Task<Void, Never>?
    @ObservationIgnored private var wasPlayingBeforeScrub = false
    @ObservationIgnored private var seekInFlight = false
    @ObservationIgnored private var chaseTarget: Double?
    @ObservationIgnored private var threadedComments: [CapComment] = []

    private static let captionsKey = "captions.enabled"
    private static let playbackSpeedKey = "playback.speed"

    private static var preferredSpeed: Float {
        guard let stored = UserDefaults.standard.object(forKey: playbackSpeedKey) as? Double else { return 1 }
        return CapViewer.nearestSpeed(to: stored)
    }
    private static let viewSessionID: String = {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        return String((0..<24).map { _ in alphabet.randomElement()! })
    }()

    init(target: ShareTarget) {
        id = target.id
        pendingStartTime = target.startTime
        highlightedCommentID = target.commentId
        captionsEnabled = UserDefaults.standard.object(forKey: Self.captionsKey) as? Bool ?? true
    }

    private func rebuildThreadsIfNeeded() {
        guard case let .loaded(detail) = content, detail.comments != threadedComments else { return }
        threadedComments = detail.comments
        threads = CommentThreads.build(detail.comments)
        threadedCommentCount = threads.reduce(0) { $0 + 1 + $1.replies.count }
    }

    var detail: CapDetail? {
        if case let .loaded(detail) = content { return detail }
        return nil
    }

    var cap: CapSummary? { detail?.cap }
    var viewer: CapViewer { detail?.viewer ?? CapViewer() }
    var settings: ViewerSettings { viewer.settings }

    var commentsEnabled: Bool { !settings.disableComments }
    var reactionsEnabled: Bool { !settings.disableReactions }
    var transcriptEnabled: Bool { !settings.disableTranscript && !viewer.isScreenshot }
    var summaryEnabled: Bool { !(settings.disableSummary && settings.disableChapters) && !viewer.isScreenshot }
    var captionsAvailable: Bool {
        guard !settings.disableCaptions, case .loaded = transcript else { return false }
        return true
    }

    var feedbackTimestamp: Double? {
        guard !viewer.isScreenshot, currentTime > 0.5 else { return nil }
        return currentTime
    }

    func isOwner(_ session: SessionModel) -> Bool {
        cap?.isOwned(by: session.credentials.userId) ?? false
    }

    // MARK: Loading

    /// Runs in the model's own task: folding or unfolding the phone cancels the screen's task partway through,
    /// and the screen that replaces it skips a model that already shows as loaded.
    func load(session: SessionModel) async {
        if loading == nil {
            loading = Task { [weak self] in
                await self?.performLoad(session: session)
                self?.loading = nil
            }
        }
        await loading?.value
    }

    private func performLoad(session: SessionModel) async {
        self.session = session
        switch content {
        case .loaded: return
        case .loading, .locked, .restricted, .unavailable: break
        }
        content = .loading
        let api = session.api
        let id = id
        async let detailResult = Result<CapDetail, CapAPIError>(catching: { () async throws(CapAPIError) -> CapDetail in try await api.cap(id) })
        switch await detailResult {
        case let .success(detail):
            apply(detail, session: session)
            await attachPlaybackIfNeeded(detail, session: session)
        case .failure(.forbidden):
            switch try? await api.capAccess(id) {
            case .passwordRequired?: content = .locked
            default: content = .restricted
            }
        case let .failure(error):
            content = .unavailable(error)
        }
    }

    private func apply(_ detail: CapDetail, session: SessionModel) {
        content = .loaded(detail)
        if detail.cap.isOwned(by: session.credentials.userId) {
            session.capChanged(detail.cap)
        }
        if let durationSeconds = detail.cap.durationSeconds, durationSeconds > 0, duration == nil {
            duration = durationSeconds
        }
        startPollingIfNeeded(detail)
    }

    private func attachPlaybackIfNeeded(_ detail: CapDetail, session: SessionModel) async {
        guard player == nil, !detail.viewer.isScreenshot, !detail.viewer.overShareLimit else { return }
        // While a saved edit renders, the old video is still at the same address; wait for the new one.
        if awaitingNewVersion {
            guard !detail.cap.isProcessing else { return }
            awaitingNewVersion = false
        }
        do {
            let playback = try await session.api.playback(id)
            self.playback = playback
            if let url = SafeURL.media(playback.url, environment: session.services.environment) {
                attachPlayer(url: url, speed: Self.preferredSpeed)
            } else {
                playbackFailed = true
            }
        } catch {
            playbackFailed = !detail.cap.isProcessing
        }
        await loadTranscriptIfNeeded()
    }

    func retry() async {
        guard let session else { return }
        content = .loading
        await load(session: session)
    }

    func refreshDetail() async {
        guard let session else { return }
        do {
            let fresh = try await session.api.cap(id)
            apply(fresh, session: session)
            await attachPlaybackIfNeeded(fresh, session: session)
            if case .unavailable = transcript { transcript = .idle }
            await loadTranscriptIfNeeded()
        } catch {
            session.toasts.show(error)
        }
    }

    private func startPollingIfNeeded(_ detail: CapDetail) {
        let waiting = detail.cap.isProcessing || detail.transcriptionStatus == .processing || detail.viewer.isGeneratingAI
        guard waiting else {
            pollTask?.cancel()
            pollTask = nil
            return
        }
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            // A full detail fetch per poll, so back off quickly and give up after about 15 minutes.
            var delay: Duration = .seconds(6)
            for _ in 0..<34 {
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled, let self, let session = self.session else { return }
                guard let fresh = try? await session.api.cap(self.id) else { continue }
                self.pollTask = nil
                self.apply(fresh, session: session)
                await self.attachPlaybackIfNeeded(fresh, session: session)
                if fresh.transcriptionStatus == .complete, case .unavailable = self.transcript {
                    self.transcript = .idle
                    await self.loadTranscriptIfNeeded()
                }
                if self.pollTask != nil || !(fresh.cap.isProcessing || fresh.transcriptionStatus == .processing || fresh.viewer.isGeneratingAI) {
                    return
                }
                delay = min(delay * 2, .seconds(30))
            }
        }
    }

    func unlock(password: String) async {
        guard let session, !isUnlocking else { return }
        let trimmed = password.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isUnlocking = true
        unlockError = nil
        defer { isUnlocking = false }
        do {
            try await session.api.unlockCap(id, password: String(trimmed.prefix(512)))
            content = .loading
            await load(session: session)
        } catch .forbidden {
            unlockError = "That password didn't work."
        } catch .badRequest {
            unlockError = "Too many attempts. Wait a few minutes and try again."
        } catch {
            unlockError = error.errorDescription
        }
    }

    // MARK: Playback

    private func attachPlayer(url: URL, speed: Float) {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        let item = AVPlayerItem(asset: AVURLAsset(url: url))
        item.preferredForwardBufferDuration = 4
        let player = AVPlayer(playerItem: item)
        player.allowsExternalPlayback = true
        player.defaultRate = speed
        rate = speed
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] time in
            MainActor.assumeIsolated {
                self?.updateTime(time.seconds.isFinite ? time.seconds : 0)
            }
        }
        observations = [
            item.observe(\.status, options: [.new]) { [weak self] item, _ in
                let status = item.status
                let seconds = item.duration.seconds
                Task { @MainActor in self?.itemStatusChanged(status, duration: seconds) }
            },
            item.observe(\.presentationSize, options: [.new]) { [weak self] item, _ in
                let size = item.presentationSize
                Task { @MainActor in
                    guard size.width > 0, size.height > 0 else { return }
                    self?.videoAspect = min(max(size.width / size.height, 0.3), 3)
                }
            },
            player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
                let status = player.timeControlStatus
                Task { @MainActor in self?.timeControlChanged(status) }
            },
        ]
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.hasEnded = true
                self?.showControls(autoHide: false)
            }
        }
        self.player = player
        NowPlaying.shared.attach(self)
    }

    private func itemStatusChanged(_ status: AVPlayerItem.Status, duration seconds: Double) {
        switch status {
        case .failed:
            playbackFailed = true
        case .readyToPlay:
            if seconds.isFinite, seconds > 0 { duration = seconds }
            if let start = pendingStartTime {
                pendingStartTime = nil
                // Loading outlives the screen, so a link left before its video was ready opens at the moment, paused.
                let shown = presentations > 0 || isFullscreen || isPictureInPictureActive
                seek(to: start, play: shown)
            }
            NowPlaying.shared.update(self)
        default:
            break
        }
    }

    private func timeControlChanged(_ status: AVPlayer.TimeControlStatus) {
        isBuffering = status == .waitingToPlayAtSpecifiedRate
        let playing = status == .playing
        guard playing != isPlaying else { return }
        isPlaying = playing
        if playing {
            hasEnded = false
            scheduleControlsHide()
        } else if !isScrubbing {
            showControls(autoHide: false)
        }
        NowPlaying.shared.update(self)
        guard playing, !trackedView, let session, !isOwner(session) else { return }
        trackedView = true
        let api = session.api
        let id = id
        let sessionID = Self.viewSessionID
        Task.detached(priority: .utility) { try? await api.trackView(id, sessionId: sessionID) }
    }

    private func updateTime(_ seconds: Double) {
        guard !isScrubbing else { return }
        let previous = currentTime
        currentTime = seconds

        let cue = TranscriptCue.active(in: cues, at: seconds)
        if cue?.id != activeCueID { activeCueID = cue?.id }
        let caption = cue?.caption(at: seconds)
        if caption != activeCaption { activeCaption = caption }

        guard let detail else { return }
        let nowPlaying = Set(detail.comments.lazy.filter { comment in
            guard comment.type == .text, let time = comment.timestamp else { return false }
            return seconds >= time && seconds < time + 4
        }.map(\.id))
        if nowPlaying != nowPlayingCommentIDs { nowPlayingCommentIDs = nowPlaying }

        let delta = seconds - previous
        guard isPlaying, delta > 0, delta < 1.5, reactionsEnabled else { return }
        let passed = detail.comments.filter { comment in
            guard comment.type == .emoji, let time = comment.timestamp else { return false }
            return time > previous && time <= seconds
        }
        for reaction in passed.prefix(3) { burst(reaction.content) }
    }

    func seek(to seconds: Double, play: Bool = true) {
        guard let player else { return }
        let target = max(0, min(seconds, duration ?? seconds))
        currentTime = target
        hasEnded = false
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                NowPlaying.shared.update(self)
            }
        }
        if play, player.timeControlStatus != .playing { player.play() }
    }

    func togglePlay() {
        guard let player else { return }
        if isPlaying || player.timeControlStatus == .waitingToPlayAtSpecifiedRate {
            player.pause()
        } else {
            if hasEnded { seek(to: 0, play: false) }
            player.play()
        }
        showControls()
    }

    func skip(by seconds: Double) {
        seek(to: currentTime + seconds, play: isPlaying)
        showControls()
    }

    func setRate(_ value: Float) {
        guard let player else { return }
        rate = value
        player.defaultRate = value
        UserDefaults.standard.set(Double(value), forKey: Self.playbackSpeedKey)
        if isPlaying { player.rate = value }
        NowPlaying.shared.update(self)
        showControls()
    }

    func pause() {
        player?.pause()
    }

    /// The Cap's route left every tab, so nothing will show this model again.
    func discard() {
        loading?.cancel()
        loading = nil
        pauseForDisappear()
    }

    func pauseForDisappear() {
        guard !isPictureInPictureActive, !isFullscreen else { return }
        player?.pause()
    }

    // MARK: Scrubbing

    func beginScrub() {
        guard player != nil, !isScrubbing else { return }
        wasPlayingBeforeScrub = isPlaying
        isScrubbing = true
        scrubTime = currentTime
        player?.pause()
        showControls(autoHide: false)
    }

    func updateScrub(to seconds: Double) {
        guard isScrubbing else { return }
        let target = max(0, min(seconds, duration ?? seconds))
        scrubTime = target
        chaseSeek(to: target)
    }

    func endScrub() {
        guard isScrubbing, let target = scrubTime else { return }
        isScrubbing = false
        chaseTarget = nil
        scrubTime = nil
        seek(to: target, play: wasPlayingBeforeScrub)
        scheduleControlsHide()
    }

    /// Drags produce far more positions than the decoder can show. Keep one seek in flight and
    /// jump to the newest position when it lands, instead of queueing a seek per touch.
    private func chaseSeek(to seconds: Double) {
        chaseTarget = seconds
        guard !seekInFlight else { return }
        performChaseSeek()
    }

    private func performChaseSeek() {
        guard let player, let target = chaseTarget else { return }
        chaseTarget = nil
        seekInFlight = true
        // Nearest keyframe while dragging; endScrub lands on the exact frame.
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .positiveInfinity, toleranceAfter: .positiveInfinity) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.seekInFlight = false
                if self.isScrubbing, self.chaseTarget != nil { self.performChaseSeek() }
            }
        }
    }

    // MARK: Controls

    func showControls(autoHide: Bool = true) {
        controlsVisible = true
        if autoHide { scheduleControlsHide() } else { hideTask?.cancel() }
    }

    func toggleControls() {
        if controlsVisible, isPlaying {
            hideTask?.cancel()
            controlsVisible = false
        } else {
            showControls()
        }
    }

    private func scheduleControlsHide() {
        hideTask?.cancel()
        guard isPlaying else { return }
        hideTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled, let self, self.isPlaying, !self.isScrubbing else { return }
            self.controlsVisible = false
        }
    }

    func setPictureInPictureActive(_ active: Bool) {
        isPictureInPictureActive = active
    }

    func burst(_ emoji: String) {
        let now = Date.timeIntervalSinceReferenceDate
        guard now - lastBurstTime > 0.08 else { return }
        lastBurstTime = now
        bursts.append(ReactionBurst(emoji: emoji, lane: Double.random(in: 0.15...0.85)))
        if bursts.count > 12 { bursts.removeFirst(bursts.count - 12) }
    }

    func finishBurst(_ burst: ReactionBurst) {
        bursts.removeAll { $0.id == burst.id }
    }

    // MARK: Transcript

    func loadTranscriptIfNeeded() async {
        guard case .idle = transcript, let detail else { return }
        switch detail.transcriptionStatus {
        case .processing?:
            transcript = .unavailable("The transcript is still being generated.")
            return
        case .noAudio?:
            transcript = .unavailable("No audio track was detected in this Cap.")
            return
        case .error?:
            transcript = .unavailable("This Cap couldn't be transcribed.")
            return
        case .skipped?, .complete?, nil:
            break
        }
        guard let session, let url = SafeURL.media(playback?.transcriptUrl, environment: session.services.environment) else {
            if playback != nil || detail.viewer.isScreenshot {
                transcript = .unavailable("There's no transcript for this Cap.")
            }
            return
        }
        transcript = .loading
        do {
            let source = try await session.services.images.text(from: url)
            let parsed = await Task.detached(priority: .userInitiated) { WebVTT.parse(source) }.value
            cues = parsed
            transcript = parsed.isEmpty ? .unavailable("The transcript is empty.") : .loaded(parsed)
        } catch {
            transcript = .unavailable("The transcript couldn't be loaded.")
        }
    }

    // MARK: Comments

    func beginComposing() {
        if composerTimestamp == nil { composerTimestamp = feedbackTimestamp }
        pause()
    }

    func refreshComposerTimestamp() {
        composerTimestamp = feedbackTimestamp
    }

    func startReply(to comment: CapComment) {
        replyingTo = comment
    }

    func cancelReply() {
        replyingTo = nil
    }

    func sendComment() async {
        guard let session, case var .loaded(detail) = content, commentsEnabled else { return }
        let text = String(draft.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
        guard !text.isEmpty, !isSendingComment else { return }
        isSendingComment = true
        defer { isSendingComment = false }
        let parent = replyingTo
        // Replies belong to their thread's moment, so only top-level comments carry a time.
        let timestamp = parent == nil ? composerTimestamp : nil
        let placeholder = makeLocalComment(.text, content: text, timestamp: timestamp, parentId: parent?.id, session: session)
        detail.comments.append(placeholder)
        content = .loaded(detail)
        pendingCommentIDs.insert(placeholder.id)
        draft = ""
        replyingTo = nil
        composerTimestamp = nil
        do {
            let created = try await session.api.createComment(id, content: text, timestamp: timestamp, parentCommentId: parent?.id)
            replaceLocal(placeholder.id, with: created)
            highlightedCommentID = created.parentCommentId ?? created.id
        } catch {
            removeLocal(placeholder.id)
            draft = text
            replyingTo = parent
            composerTimestamp = timestamp
            session.toasts.show(error)
        }
    }

    func react(_ emoji: String) async {
        guard let session, case var .loaded(detail) = content, reactionsEnabled else { return }
        burst(emoji)
        let placeholder = makeLocalComment(.emoji, content: emoji, timestamp: feedbackTimestamp, parentId: nil, session: session)
        detail.comments.append(placeholder)
        content = .loaded(detail)
        pendingCommentIDs.insert(placeholder.id)
        do {
            let created = try await session.api.createReaction(id, emoji: emoji, timestamp: placeholder.timestamp)
            replaceLocal(placeholder.id, with: created)
        } catch {
            removeLocal(placeholder.id)
            session.toasts.show(error)
        }
    }

    func deleteComment(_ comment: CapComment) async {
        guard let session, case .loaded = content else { return }
        do {
            try await session.api.deleteComment(comment.id)
            guard case var .loaded(detail) = content else { return }
            detail.comments.removeAll { $0.id == comment.id || $0.parentCommentId == comment.id }
            content = .loaded(detail)
            session.toasts.show("Comment deleted", systemImage: "trash")
        } catch {
            session.toasts.show(error)
        }
    }

    private func makeLocalComment(_ kind: CommentKind, content: String, timestamp: Double?, parentId: String?, session: SessionModel) -> CapComment {
        let user = session.user
        return CapComment(
            id: "local-\(UUID().uuidString)",
            videoId: id.rawValue,
            type: kind,
            content: content,
            timestamp: timestamp,
            parentCommentId: parentId,
            createdAt: .now,
            updatedAt: .now,
            author: CommentAuthor(id: session.credentials.userId, name: user?.displayName, imageUrl: user?.imageUrl)
        )
    }

    private func replaceLocal(_ localId: String, with comment: CapComment) {
        pendingCommentIDs.remove(localId)
        guard case var .loaded(detail) = content else { return }
        if let index = detail.comments.firstIndex(where: { $0.id == localId }) {
            detail.comments[index] = comment
        } else {
            detail.comments.append(comment)
        }
        content = .loaded(detail)
    }

    private func removeLocal(_ localId: String) {
        pendingCommentIDs.remove(localId)
        guard case var .loaded(detail) = content else { return }
        detail.comments.removeAll { $0.id == localId }
        content = .loaded(detail)
    }

    // MARK: Owner actions

    func rename(to title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let session, case var .loaded(detail) = content, !trimmed.isEmpty, trimmed != detail.cap.title else { return }
        do {
            let updated = try await session.api.updateTitle(id, title: String(trimmed.prefix(255)))
            detail.cap = updated
            content = .loaded(detail)
            session.capChanged(updated)
            session.toasts.show("Title updated", systemImage: "pencil")
        } catch {
            session.toasts.show(error)
        }
    }

    func setPassword(_ password: String?) async -> Bool {
        guard let session, case var .loaded(detail) = content else { return false }
        do {
            let updated = try await session.api.updatePassword(id, password: password)
            detail.cap = updated
            content = .loaded(detail)
            session.capChanged(updated)
            session.toasts.show(password == nil ? "Password removed" : "Password set", systemImage: password == nil ? "lock.open" : "lock.fill")
            return true
        } catch {
            session.toasts.show(error)
            return false
        }
    }

    private(set) var updatingSharing = false

    func setPublic(_ isPublic: Bool) async {
        await updateSharing { cap, session in await CapActions.setPublic(cap, isPublic: isPublic, session: session) }
    }

    func setLinkAccess(_ linkAccess: LinkAccess) async {
        await updateSharing { cap, session in await CapActions.setLinkAccess(cap, linkAccess: linkAccess, session: session) }
    }

    private func updateSharing(_ change: (CapSummary, SessionModel) async -> CapSummary?) async {
        guard !updatingSharing, let session, case let .loaded(detail) = content else { return }
        updatingSharing = true
        defer { updatingSharing = false }
        guard let updated = await change(detail.cap, session), case var .loaded(current) = content else { return }
        current.cap = updated
        content = .loaded(current)
    }

    func report(_ reason: ContentReportReason) async -> Bool {
        guard let session else { return false }
        do {
            try await session.api.reportCap(id, reason: reason)
            session.toasts.show("Thanks. Cap Support will review this.", systemImage: "flag.fill")
            return true
        } catch {
            session.toasts.show(error)
            return false
        }
    }

    func blockOwner() async -> Bool {
        guard let session, let ownerId = cap?.ownerId else { return false }
        do {
            try await session.api.blockUser(ownerId)
            session.capDeleted(id.rawValue)
            session.invalidateLibraries()
            session.toasts.show("User blocked", systemImage: "hand.raised.fill")
            return true
        } catch {
            session.toasts.show(error)
            return false
        }
    }

    func saveToPhotos() async {
        guard let session, !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            session.toasts.show("Allow Cap to add videos in Settings > Privacy > Photos.", systemImage: "photo.badge.exclamationmark", style: .error)
            return
        }
        session.toasts.show("Saving to Photos…", systemImage: "arrow.down.circle", style: .info)
        do {
            let link = try await session.api.download(id)
            guard let url = SafeURL.web(link.url) ?? SafeURL.media(link.url, environment: session.services.environment) else {
                throw CapAPIError.invalidResponse
            }
            let file = try await Self.downloadVideo(from: url, suggestedName: link.fileName)
            defer { try? FileManager.default.removeItem(at: file) }
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: file)
            }
            session.toasts.show("Saved to Photos", systemImage: "checkmark.circle.fill")
        } catch {
            session.toasts.show("The video couldn't be saved. Try again.", systemImage: "exclamationmark.triangle.fill", style: .error)
        }
    }

    /// Reuses the playback MP4, so the editor opens without fetching or probing it again.
    var editorSource: AVURLAsset? {
        guard playback?.kind == .mp4 else { return nil }
        return player?.currentItem?.asset as? AVURLAsset
    }

    #if DEBUG
    var editorSourceReady: Bool {
        guard let asset = editorSource, player?.currentItem?.status == .readyToPlay else { return false }
        if case .loaded = asset.status(of: .tracks) { return true }
        return false
    }
    #endif

    /// After an edit is saved the video is rebuilt under the same address, so drop the current player and let
    /// the next refresh attach the new version once processing finishes.
    func prepareForNewVersion() async {
        player?.pause()
        if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        player?.replaceCurrentItem(with: nil)
        player = nil
        playback = nil
        playbackFailed = false
        awaitingNewVersion = true
        await refreshDetail()
    }

    func tearDown() {
        pollTask?.cancel()
        pollTask = nil
        player?.pause()
    }

    var nowPlayingTitle: String { cap?.title ?? "Cap" }
    var nowPlayingArtist: String? { cap?.ownerName.isEmpty == false ? cap?.ownerName : nil }

    nonisolated private static func downloadVideo(from url: URL, suggestedName: String) async throws -> URL {
        let configuration = URLSessionTransport.makeConfiguration()
        configuration.timeoutIntervalForResource = 60 * 60
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        let (temporary, response) = try await session.download(from: url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            try? FileManager.default.removeItem(at: temporary)
            throw CapAPIError.invalidResponse
        }
        let ext = URL(fileURLWithPath: suggestedName).pathExtension.lowercased()
        let safeExt = ["mp4", "mov", "m4v"].contains(ext) ? ext : "mp4"
        let destination = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).\(safeExt)")
        try FileManager.default.moveItem(at: temporary, to: destination)
        return destination
    }
}

extension Result where Failure == CapAPIError {
    init(catching body: () async throws(CapAPIError) -> Success) async {
        do {
            self = .success(try await body())
        } catch {
            self = .failure(error)
        }
    }
}
