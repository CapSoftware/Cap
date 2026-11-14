import AVFoundation
import CapKit
import QuartzCore
import SwiftUI

/// The preview is an `AVMutableComposition` of the kept clips, rebuilt in a few milliseconds per change, drawn through
/// Studio's compositor when the look changes anything. A Cap's cuts are rendered by Cap; anything styled renders here.
@MainActor
@Observable
final class EditorModel {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    enum Document {
        case cap(CapID, preloaded: AVURLAsset?)
        case studio(StudioProject)
    }

    let document: Document
    let title: String
    let state: CapEditState
    private let session: SessionModel

    private(set) var phase: Phase = .loading
    private(set) var timeline: EditTimeline
    private(set) var undoStack: [Snapshot] = []
    private(set) var redoStack: [Snapshot] = []
    var selectedClip: Int?

    /// Two players for the edit: a rebuilt preview is prepared on the hidden one and swapped in once its frame is
    /// decoded, so the old frame stays up meanwhile instead of the preview going black.
    let players = [AVPlayer(), AVPlayer()]
    private(set) var activePlayer = 0
    var player: AVPlayer { players[activePlayer] }
    /// Plays the untouched video, shown while a trim handle is dragged so frames outside the edit can be seen.
    let sourcePlayer = AVPlayer()
    private(set) var isTrimming = false
    /// The untouched video covers the preview from the first frame a trim lands on until the rebuilt preview has
    /// its own, so neither black nor the old edit shows in between.
    private(set) var showsSource = false

    private(set) var outputTime: Double = 0
    private(set) var isPlaying = false
    private(set) var isSaving = false
    var errorMessage: String?

    private(set) var thumbnails: [UIImage] = []
    static let thumbnailCount = 24
    private(set) var detailThumbnails: [Int: UIImage] = [:]
    private static let detailCount = thumbnailCount * Int(TrimTrack.zoomFactor)
    private var detailTask: Task<Void, Never>?
    private(set) var videoAspect: CGFloat = 9.0 / 16
    private(set) var sourceAspect: CGFloat = 9.0 / 16

    // MARK: Look

    private(set) var look: StudioLook
    private(set) var music: StudioMusic?
    private(set) var voiceVolume: Double
    /// Shown over the player after a look change while paused: the last decoded frame drawn with the new look.
    private(set) var still: CVPixelBuffer?
    private(set) var stillGeneration = 0
    private(set) var renderSize: CGSize = .zero
    private(set) var musicWaveform: [Float] = []
    let scene: StudioScene

    private var screenSource: StudioTrackSource?
    private var cameraSource: StudioTrackSource?
    private var musicSource: StudioMusicSource?
    private var primaryAsset: AVAsset?
    private var primaryOffset: Double = 0
    private var timeObservers: [Any] = []
    private var rebuildGeneration = 0
    private var endObserver: NSObjectProtocol?
    private var itemReady: NSKeyValueObservation?
    private var rebuildPending = false
    private var thumbnailTask: Task<Void, Never>?
    private var compositionStale = false
    private var prewarm: Task<Void, Never>?
    let metrics = EditorMetrics()

    struct Snapshot: Equatable {
        var timeline: EditTimeline
        var look: StudioLook
        var music: StudioMusic?
        var voiceVolume: Double
    }

    init(capId: CapID, title: String, state: CapEditState, session: SessionModel, preloaded: AVURLAsset? = nil) {
        document = .cap(capId, preloaded: preloaded)
        self.title = title
        self.state = state
        self.session = session
        timeline = EditTimeline(sourceDuration: state.duration)
        look = .untouched
        music = nil
        voiceVolume = 1
        scene = StudioScene(look: .untouched, screen: nil, camera: nil)
        for player in players { player.automaticallyWaitsToMinimizeStalling = false }
        sourcePlayer.automaticallyWaitsToMinimizeStalling = false
    }

    init(project: StudioProject, session: SessionModel) {
        document = .studio(project)
        title = project.title
        state = CapEditState(status: .available, duration: project.duration, hasEdits: false)
        self.session = session
        timeline = project.timeline
        look = project.look
        music = project.music
        voiceVolume = project.voiceVolume
        scene = StudioScene(look: project.look, screen: nil, camera: nil)
        for player in players { player.automaticallyWaitsToMinimizeStalling = false }
        sourcePlayer.automaticallyWaitsToMinimizeStalling = false
    }

    var capId: CapID? {
        if case let .cap(id, _) = document { id } else { nil }
    }

    var project: StudioProject? {
        guard case var .studio(project) = document else { return nil }
        project.look = look
        project.music = music
        project.voiceVolume = voiceVolume
        project.clips = timeline.isUnchanged ? nil : timeline.clips
        return project
    }

    var isStudio: Bool { project != nil }
    var hasCamera: Bool { cameraSource != nil }
    var hasScreen: Bool { screenSource != nil }

    var exportSize: CGSize {
        StudioLayout.canvasSize(look: look, primary: screenSource?.info.displaySize, camera: cameraSource?.info.displaySize, longEdge: StudioLayout.exportLongEdge)
    }

    private var snapshot: Snapshot { Snapshot(timeline: timeline, look: look, music: music, voiceVolume: voiceVolume) }

    /// A Cap with only cuts saves on Cap's servers; anything styled has to be rendered on the phone.
    var needsRender: Bool {
        isStudio || !look.isIdentity(hasCamera: false) || music != nil || voiceVolume != 1
    }

    var workDirectory: URL {
        switch document {
        case let .studio(project):
            return StudioSession.shared.store.directory(for: project.id)
        case let .cap(id, _):
            let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            let directory = caches.appending(path: "EditorMedia/\(id.rawValue)", directoryHint: .isDirectory)
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            return directory
        }
    }

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }
    var hasChanges: Bool { !timeline.isUnchanged || needsRender && !isStudio }
    var canSplit: Bool { timeline.splitting(atOutput: outputTime) != nil }
    var canDelete: Bool {
        guard let selectedClip else { return false }
        return timeline.deleting(clipAt: selectedClip) != nil
    }
    var activeClip: Int? {
        if let selectedClip, timeline.clips.indices.contains(selectedClip) { return selectedClip }
        return timeline.clips.count == 1 ? 0 : nil
    }

    // MARK: Loading

    func load() async {
        metrics.begin()
        do {
            switch document {
            case let .cap(_, preloaded):
                let asset: AVURLAsset
                if let preloaded {
                    asset = preloaded
                    metrics.mark("reusedPlayback")
                } else {
                    asset = AVURLAsset(url: try await sourceURL(), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
                }
                screenSource = try await StudioTrackSource.load(asset: asset, offset: 0)
            case let .studio(project):
                let store = StudioSession.shared.store
                async let screen = Self.loadTrack(project.screen, url: { store.url($0, in: project.id) })
                async let camera = Self.loadTrack(project.camera, url: { store.url($0, in: project.id) })
                screenSource = try await screen
                cameraSource = try? await camera
                guard screenSource != nil || cameraSource != nil else { throw EditorError.noVideo }
            }
            let primary = screenSource ?? cameraSource
            primaryAsset = primary?.asset
            primaryOffset = primary?.offset ?? 0
            if let size = primary?.info.displaySize, size.height > 0 {
                sourceAspect = min(max(size.width / size.height, 0.4), 2.4)
            }
            scene.update {
                $0.screen = self.screenSource?.info
                $0.camera = self.cameraSource?.info
            }
            metrics.mark("tracksLoaded")
            if !look.isIdentity(hasCamera: cameraSource != nil) {
                let scene = scene
                let size = StudioLayout.canvasSize(look: look, primary: screenSource?.info.displaySize, camera: cameraSource?.info.displaySize, longEdge: StudioLayout.previewLongEdge)
                prewarm = Task.detached(priority: .userInitiated) { scene.renderer.prewarm(scene: scene, size: size) }
            }
            await loadBackgroundImage()
            await loadMusic()
            // The kernels compile while the decoders start up; neither waits for the other.

            try rebuildSource()
            try rebuild(seekTo: 0)
            observePlayback()
            phase = .ready
            Usage.screen(isStudio ? "studio_editor" : "editor")
            if let primaryAsset { loadThumbnails(asset: primaryAsset) }
        } catch {
            phase = .failed((error as? CapAPIError)?.errorDescription ?? "Cap couldn't open this video for editing. Try again.")
        }
    }

    nonisolated private static func loadTrack(_ track: StudioProject.Track?, url: (String) -> URL) async throws -> StudioTrackSource? {
        guard let track else { return nil }
        return try await StudioTrackSource.load(url: url(track.file), offset: track.offset, gaps: track.gaps ?? [], audio: track.audio.map { (url($0.file), $0.offset, $0.duration) })
    }

    /// Playback is an MP4 for every editable Cap; the download link covers anything else.
    private func sourceURL() async throws -> URL {
        guard let capId else { throw EditorError.noVideo }
        let environment = session.services.environment
        let playback = try await session.api.playback(capId)
        if playback.kind == .mp4, let url = SafeURL.media(playback.url, environment: environment) { return url }
        let download = try await session.api.download(capId)
        guard let url = SafeURL.media(download.url, environment: environment) else { throw EditorError.noVideo }
        return url
    }

    private func loadThumbnails(asset: AVAsset) {
        let duration = timeline.sourceDuration
        let scale = UITraitCollection.current.displayScale
        thumbnailTask?.cancel()
        thumbnailTask = Task { [weak self] in
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 96 * scale, height: 96 * scale)
            // Nearest keyframe is plenty for a filmstrip and avoids decoding up to each exact time.
            let tolerance = CMTime(seconds: max(0.5, duration / Double(Self.thumbnailCount)), preferredTimescale: 600)
            generator.requestedTimeToleranceBefore = tolerance
            generator.requestedTimeToleranceAfter = tolerance
            let shift = self?.primaryOffset ?? 0
            let times = (0..<Self.thumbnailCount).map { index in
                CMTime(seconds: max(0, duration * (Double(index) + 0.5) / Double(Self.thumbnailCount) - shift), preferredTimescale: 600)
            }
            var images = [UIImage?](repeating: nil, count: times.count)
            var filled = 0
            for await result in generator.images(for: times) {
                guard let self, !Task.isCancelled else { return }
                guard let image = try? result.image,
                      let index = times.firstIndex(where: { $0 == result.requestedTime })
                else { continue }
                images[index] = UIImage(cgImage: image)
                filled += 1
                if filled == 1 { metrics.mark("firstThumbnail") }
                // Show what has arrived, filling gaps with the nearest frame so the strip is never empty.
                self.thumbnails = Self.filled(images)
            }
            self?.metrics.mark("thumbnailsReady")
        }
    }

    private static func filled(_ images: [UIImage?]) -> [UIImage] {
        guard let first = images.first(where: { $0 != nil }) ?? nil else { return [] }
        var last = first
        return images.map { image in
            if let image { last = image }
            return last
        }
    }

    func thumbnail(atSource time: Double, detailed: Bool = false) -> UIImage? {
        guard !thumbnails.isEmpty, timeline.sourceDuration > 0 else { return nil }
        let fraction = time / timeline.sourceDuration
        if detailed, let image = detailThumbnails[Int(fraction * Double(Self.detailCount))] { return image }
        let index = Int(fraction * Double(thumbnails.count))
        return thumbnails[min(max(0, index), thumbnails.count - 1)]
    }

    /// The expanded strip shows a fifth of the video, so it needs frames five times closer together than the
    /// filmstrip has. Only the stretch around `time` is decoded.
    func loadDetailThumbnails(aroundSource time: Double) {
        guard let asset = primaryAsset, timeline.sourceDuration > 0 else { return }
        let shift = primaryOffset
        let duration = timeline.sourceDuration
        let step = duration / Double(Self.detailCount)
        let centre = Int(time / step)
        let first: Int = max(0, centre - Self.thumbnailCount)
        let last: Int = min(Self.detailCount - 1, centre + Self.thumbnailCount)
        guard first <= last else { return }
        let missing: [Int] = (first...last).filter { (index: Int) -> Bool in detailThumbnails[index] == nil }
        let wanted: [Int] = missing.sorted { (a: Int, b: Int) -> Bool in abs(a - centre) < abs(b - centre) }
        guard !wanted.isEmpty else { return }
        let scale = UITraitCollection.current.displayScale
        detailTask?.cancel()
        detailTask = Task { [weak self] in
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 96 * scale, height: 96 * scale)
            let tolerance = CMTime(seconds: step / 2, preferredTimescale: 600)
            generator.requestedTimeToleranceBefore = tolerance
            generator.requestedTimeToleranceAfter = tolerance
            let times = wanted.map { CMTime(seconds: max(0, (Double($0) + 0.5) * step - shift), preferredTimescale: 600) }
            for await result in generator.images(for: times) {
                guard let self, !Task.isCancelled else { return }
                guard let image = try? result.image,
                      let index = times.firstIndex(where: { $0 == result.requestedTime })
                else { continue }
                self.detailThumbnails[wanted[index]] = UIImage(cgImage: image)
            }
        }
    }

    func cancelDetailThumbnails() {
        detailTask?.cancel()
        detailTask = nil
    }

    // MARK: Composition

    /// Only track references change, so building costs milliseconds; the new item loads on the hidden
    /// player and replaces the visible one when its first frame is ready.
    private func rebuild(seekTo output: Double) throws {
        let started = CACurrentMediaTime()
        let built = try compose(clips: timeline.clips, remembersFrames: true)
        let item = AVPlayerItem(asset: built.composition)
        item.videoComposition = built.videoComposition
        item.audioMix = built.audioMix
        item.preferredForwardBufferDuration = 2
        renderSize = built.renderSize
        if built.renderSize.height > 0 { videoAspect = built.renderSize.width / built.renderSize.height }
        compositionStale = false
        clearStill()
        metrics.record("rebuildMs", (CACurrentMediaTime() - started) * 1000)

        let target = min(max(0, output), timeline.outputDuration)
        outputTime = target
        rebuildGeneration += 1
        let generation = rebuildGeneration
        // The first build has nothing on screen to keep, so it loads straight into the visible player.
        let next = player.currentItem == nil ? activePlayer : 1 - activePlayer
        let incoming = players[next]
        // The old edit stops where it is. `isPlaying` carries on as the intent, and Play or a seek made before the
        // new preview is up is applied to it when it arrives.
        rebuildPending = true
        player.pause()
        incoming.pause()
        incoming.replaceCurrentItem(with: item)
        // A seek on an item that isn't ready yet completes at once, with nothing decoded, and swapping on that
        // showed black until the frame arrived. Once the item is ready, the seek completing means the frame is there.
        itemReady?.invalidate()
        itemReady = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            let status = item.status
            guard status != .unknown else { return }
            Task { @MainActor in
                guard let self, generation == self.rebuildGeneration, self.itemReady != nil else { return }
                self.itemReady?.invalidate()
                self.itemReady = nil
                guard status == .readyToPlay else {
                    self.previewFailed()
                    return
                }
                incoming.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                    Task { @MainActor in
                        guard let self, generation == self.rebuildGeneration, !self.closed else { return }
                        // An unfinished seek was replaced by a newer one on the same player: the first build loads
                        // into the visible player, which a scrub can already be seeking. Only a failed item is a loss.
                        guard incoming.currentItem?.status != .failed else {
                            self.previewFailed()
                            return
                        }
                        if !self.isTrimming { self.showsSource = false }
                        let outgoing = self.players[self.activePlayer]
                        self.activePlayer = next
                        self.rebuildPending = false
                        if outgoing !== incoming {
                            outgoing.pause()
                            outgoing.replaceCurrentItem(with: nil)
                        }
                        // A scrub on the first build is already seeking this player; any other scrub was moving the
                        // old one, so its position has to be carried over.
                        if outgoing !== incoming || !self.isScrubbing, abs(self.outputTime - target) > 0.02 {
                            incoming.seek(to: CMTime(seconds: self.outputTime, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
                        }
                        if self.isPlaying { incoming.play() }
                        self.metrics.record("rebuildToFrameMs", (CACurrentMediaTime() - started) * 1000)
                    }
                }
            }
        }
    }

    /// An untouched Cap plays straight from the decoder; anything styled, or with a camera, goes through Studio's
    /// compositor at a size made for the screen, not the export.
    private func compose(clips: [EditRange], remembersFrames: Bool, longEdge: Double = StudioLayout.previewLongEdge) throws -> StudioComposition {
        try StudioComposition.build(
            clips: clips,
            screen: screenSource,
            camera: cameraSource,
            music: musicSource,
            voiceVolume: voiceVolume,
            scene: scene,
            longEdge: longEdge,
            remembersFrames: remembersFrames,
            passthrough: look.isIdentity(hasCamera: cameraSource != nil)
        )
    }

    /// The whole recording with the current look, shown while a trim handle is dragged.
    private func rebuildSource() throws {
        let built = try compose(clips: [EditRange(start: 0, end: timeline.sourceDuration)], remembersFrames: false)
        let item = AVPlayerItem(asset: built.composition)
        item.videoComposition = built.videoComposition
        sourcePlayer.replaceCurrentItem(with: item)
    }

    /// The last good preview stays on its player, and Try again rebuilds from the timeline as it stands.
    private func previewFailed() {
        guard !closed else { return }
        rebuildPending = false
        showsSource = false
        isPlaying = false
        phase = .failed("Cap couldn't load the preview for this edit. Try again.")
    }

    private func show(_ next: EditTimeline, previous: EditTimeline, seekTo output: Double) {
        if next.playsSame(as: previous) {
            outputTime = min(max(0, output), next.outputDuration)
            showsSource = false
            return
        }
        do {
            try rebuild(seekTo: output)
        } catch {
            showsSource = false
        }
    }

    private func observePlayback() {
        removePlaybackObservers()
        timeObservers = players.enumerated().map { index, player in
            player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] time in
                MainActor.assumeIsolated {
                    guard let self, index == self.activePlayer, !self.isScrubbing, !self.isTrimming, !self.rebuildPending else { return }
                    self.outputTime = time.seconds.isFinite ? time.seconds : 0
                    self.isPlaying = player.rate != 0
                }
            }
        }
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] notification in
            let ended = (notification.object as? AVPlayerItem).map(ObjectIdentifier.init)
            MainActor.assumeIsolated {
                guard let self, let current = self.player.currentItem, ended == ObjectIdentifier(current) else { return }
                self.isPlaying = false
            }
        }
    }

    // MARK: Playback

    func togglePlay() {
        if rebuildPending {
            if !isPlaying, outputTime >= timeline.outputDuration - 0.05 { outputTime = 0 }
            isPlaying.toggle()
            return
        }
        if isPlaying {
            player.pause()
            isPlaying = false
        } else {
            refreshStaleComposition()
            clearStill()
            if outputTime >= timeline.outputDuration - 0.05 { seek(toOutput: 0) }
            player.play()
            isPlaying = true
        }
    }

    /// Frames the player composed ahead of time still have the old look; a fresh composition object drops them.
    private func refreshStaleComposition() {
        guard compositionStale, let item = player.currentItem, let current = item.videoComposition else { return }
        compositionStale = false
        item.videoComposition = current.mutableCopy() as? AVVideoComposition
    }

    private(set) var isScrubbing = false
    private var seekInFlight = false
    private var pendingSeek: Seek?
    private var settleTask: Task<Void, Never>?

    func beginScrub() {
        clearStill()
        refreshStaleComposition()
        isScrubbing = true
        if isPlaying {
            player.pause()
            isPlaying = false
        }
    }

    func scrub(toOutput time: Double) {
        outputTime = min(max(0, time), timeline.outputDuration)
        scrubSeek(source: false, to: outputTime)
    }

    func endScrub() {
        isScrubbing = false
        settle(source: false, to: outputTime, after: 0)
    }

    func seek(toOutput time: Double) {
        clearStill()
        refreshStaleComposition()
        outputTime = min(max(0, time), timeline.outputDuration)
        player.seek(to: CMTime(seconds: outputTime, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    func scrub(toSource time: Double) {
        scrub(toOutput: timeline.outputTime(forSource: time))
    }

    func seek(toSource time: Double) {
        seek(toOutput: timeline.outputTime(forSource: time))
    }

    var playheadSource: Double { displayedTimeline.sourceTime(forOutput: outputTime) }

    /// A drag shows the exact frame under the finger for as long as exact seeks keep up with it, which is what makes
    /// a trim point choosable. Cap's 250-frame GOPs mean an exact seek can decode up to eight seconds of video, so
    /// when they run slow the nearest earlier keyframe is shown while the finger moves and one exact seek lands on
    /// the frame once it rests or lifts. A trim is chosen by its frame, so it waits longer for the exact one.
    private func scrubSeek(source: Bool, to time: Double, metric: String = "scrubFrameMs") {
        let budget = source ? 0.4 : 0.2
        if exactSeekCost <= budget {
            settleTask?.cancel()
            chaseSeek(Seek(source: source, time: time, exact: true, metric: metric, budget: budget))
        } else {
            chaseSeek(Seek(source: source, time: time, exact: false, metric: metric, budget: budget))
            settle(source: source, to: time, after: 0.12)
        }
    }

    private struct Seek {
        let source: Bool
        let time: Double
        let exact: Bool
        let metric: String
        var budget: Double?
    }

    /// Seconds an exact seek has been taking lately. A hidden player seeks without decoding, so this can only be
    /// learned from seeks made while dragging.
    private var exactSeekCost: Double = 0
    private var seekSerial = 0
    private var exactInFlight: (serial: Int, issued: CFTimeInterval, watched: Bool)?

    private func settle(source: Bool, to time: Double, after delay: Double) {
        settleTask?.cancel()
        settleTask = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            guard !Task.isCancelled else { return }
            self?.chaseSeek(Seek(source: source, time: time, exact: true, metric: "settleMs"))
        }
    }

    /// One seek at a time; while one is running only the newest target is kept, so dragging never queues up.
    private func chaseSeek(_ seek: Seek) {
        guard !seekInFlight else {
            // The newest target wins; the settle seek always comes last, so an exact landing is never lost.
            pendingSeek = seek
            watchForOvertake(by: seek)
            return
        }
        issue(seek)
    }

    /// Whatever exact seek is running, a settle seek included, gets its budget counted from when it was issued.
    private func watchForOvertake(by seek: Seek) {
        guard let budget = seek.budget, let running = exactInFlight, !running.watched else { return }
        exactInFlight?.watched = true
        let remaining = max(0, running.issued + budget - CACurrentMediaTime())
        Task { [weak self] in
            if remaining > 0 { try? await Task.sleep(for: .seconds(remaining)) }
            self?.overtake(running.serial, budget: budget)
        }
    }

    private func issue(_ seek: Seek) {
        seekInFlight = true
        seekSerial += 1
        let serial = seekSerial
        let issued = CACurrentMediaTime()
        let before: CMTime = seek.exact ? .zero : .positiveInfinity
        let player = seek.source ? sourcePlayer : self.player
        exactInFlight = seek.exact ? (serial, issued, false) : nil
        player.seek(to: CMTime(seconds: seek.time, preferredTimescale: 600), toleranceBefore: before, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in
                guard let self, serial == self.seekSerial else { return }
                let took = CACurrentMediaTime() - issued
                self.metrics.record(seek.metric, took * 1000)
                if seek.exact { self.exactSeekCost = (self.exactSeekCost + took) / 2 }
                if seek.source, self.isTrimming { self.showsSource = true }
                self.seekInFlight = false
                self.exactInFlight = nil
                if let next = self.pendingSeek {
                    self.pendingSeek = nil
                    self.chaseSeek(next)
                }
            }
        }
    }

    /// An exact seek still running after its budget, with the finger already somewhere else, gives way to a keyframe
    /// at the newer position, so the picture never freezes for longer than the budget. One slow seek among fast ones
    /// keeps exact frames; a second in a row switches to keyframes until exact seeks are quick again.
    private func overtake(_ serial: Int, budget: Double) {
        guard serial == seekSerial, seekInFlight else { return }
        guard let next = pendingSeek, next.budget != nil else {
            exactInFlight?.watched = false
            return
        }
        exactSeekCost = (exactSeekCost + budget * 1.5) / 2
        pendingSeek = nil
        metrics.record("overtakenSeeks", 1)
        issue(Seek(source: next.source, time: next.time, exact: false, metric: next.metric, budget: budget))
        settle(source: next.source, to: next.time, after: 0.12)
    }

    // MARK: Editing

    private func apply(_ next: EditTimeline, seekTo output: Double) {
        let started = CACurrentMediaTime()
        let previous = timeline
        pushUndo()
        timeline = next
        show(next, previous: previous, seekTo: output)
        metrics.record("editMs", (CACurrentMediaTime() - started) * 1000)
        changed()
    }

    private func pushUndo() {
        undoStack.append(snapshot)
        redoStack.removeAll()
    }

    func split() {
        guard let next = timeline.splitting(atOutput: outputTime) else { return }
        selectedClip = nil
        apply(next, seekTo: outputTime)
    }

    func deleteSelected() {
        guard let index = selectedClip, let next = timeline.deleting(clipAt: index) else { return }
        let resumeAt = timeline.outputStarts[index]
        selectedClip = nil
        apply(next, seekTo: resumeAt)
    }

    func undo() {
        guard let previous = undoStack.popLast() else { return }
        redoStack.append(snapshot)
        restore(previous)
    }

    func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(snapshot)
        restore(next)
    }

    private func restore(_ target: Snapshot) {
        let current = snapshot
        let source = timeline.sourceTime(forOutput: outputTime)
        timeline = target.timeline
        selectedClip = nil
        let audioChanged = current.music != target.music || current.voiceVolume != target.voiceVolume
        music = target.music
        voiceVolume = target.voiceVolume
        Task {
            if audioChanged, !(await loadMusic()) { return }
            show(look: target.look, timelineFrom: current.timeline, forceRebuild: audioChanged, seekTo: target.timeline.outputTime(forSource: source))
        }
        changed()
    }

    // MARK: Look

    private var lookGesture = false

    func beginLookGesture() {
        guard !lookGesture else { return }
        lookGesture = true
        pushUndo()
    }

    func endLookGesture() {
        lookGesture = false
    }

    func setLook(_ change: (inout StudioLook) -> Void) {
        var next = look
        change(&next)
        guard next != look else { return }
        if !lookGesture { pushUndo() }
        show(look: next, timelineFrom: timeline, forceRebuild: false, seekTo: outputTime)
        changed()
    }

    /// Applies a look. Only what changed is redone: a new frame size or the switch between plain playback and
    /// compositing rebuilds the preview, anything else just redraws the frame on screen.
    private func show(look next: StudioLook, timelineFrom previous: EditTimeline, forceRebuild: Bool, seekTo output: Double) {
        let started = CACurrentMediaTime()
        let old = look
        look = next
        let hasCamera = cameraSource != nil
        let backgroundChanged = old.background != next.background
        scene.update { $0.look = next }
        let size = StudioLayout.canvasSize(look: next, primary: screenSource?.info.displaySize, camera: cameraSource?.info.displaySize, longEdge: StudioLayout.previewLongEdge)
        let needsRebuild = forceRebuild
            || !timeline.playsSame(as: previous)
            || old.isIdentity(hasCamera: hasCamera) != next.isIdentity(hasCamera: hasCamera)
            || (videoCompositionActive && size != renderSize)
        if needsRebuild {
            do {
                try rebuildSource()
                try rebuild(seekTo: output)
            } catch {
                previewFailed()
            }
        } else {
            outputTime = min(max(0, output), timeline.outputDuration)
            compositionStale = true
            refreshStill()
        }
        metrics.record("lookMs", (CACurrentMediaTime() - started) * 1000)
        if backgroundChanged { Task { await loadBackgroundImage() } }
    }

    private var videoCompositionActive: Bool { player.currentItem?.videoComposition != nil }

    /// Redraws the paused frame with the current look from the frame already decoded, in a couple of milliseconds.
    private func refreshStill() {
        guard !isPlaying, !isScrubbing, !isTrimming, videoCompositionActive else { return }
        let started = CACurrentMediaTime()
        if let frame = scene.renderStill(near: CMTime(seconds: outputTime, preferredTimescale: 600)) {
            still = frame
            stillGeneration += 1
            metrics.record("stillMs", (CACurrentMediaTime() - started) * 1000)
        } else {
            // Nothing decoded near here yet: an exact seek composes the frame with the new look.
            player.seek(to: CMTime(seconds: outputTime, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        }
    }

    private func clearStill() {
        guard still != nil else { return }
        still = nil
        stillGeneration += 1
    }

    @ObservationIgnored private var backgroundLoaded: StudioBackground?

    /// Wallpapers and photos are decoded off the main thread at the size they're drawn, then the frame is redrawn.
    private func loadBackgroundImage() async {
        beginMedia()
        defer { endMedia() }
        let background = look.background
        guard background != backgroundLoaded else { return }
        let url: URL? = switch background {
        case let .wallpaper(name): StudioAssets.wallpaperURL(name)
        case let .image(file): workDirectory.appending(path: file)
        default: nil
        }
        let image: CGImage? = if let url { await Task.detached(priority: .userInitiated) { StudioAssets.loadImage(url) }.value } else { nil }
        guard look.background == background else { return }
        backgroundLoaded = background
        scene.update { $0.backgroundImage = image }
        if url != nil {
            compositionStale = true
            refreshStill()
        }
    }

    // MARK: Music

    func setMusic(_ next: StudioMusic?) async {
        guard next != music else { return }
        pushUndo()
        music = next
        changed()
        guard await loadMusic() else { return }
        show(look: look, timelineFrom: timeline, forceRebuild: true, seekTo: outputTime)
    }

    func beginAudioGesture() {
        guard !lookGesture else { return }
        lookGesture = true
        pushUndo()
    }

    /// Volumes live in the audio mix, which only a rebuild changes; it keeps the frame on screen meanwhile.
    func setVolumes(music musicVolume: Double?, voice: Double?) {
        if let musicVolume, var current = music {
            current.volume = musicVolume
            music = current
        }
        if let voice { voiceVolume = voice }
        if !lookGesture { pushUndo() }
        Task {
            guard await loadMusic() else { return }
            show(look: look, timelineFrom: timeline, forceRebuild: true, seekTo: outputTime)
        }
        changed()
    }

    @ObservationIgnored private var loadedMusic: (source: StudioMusic.Source, url: URL)?

    private func musicURL(_ source: StudioMusic.Source) -> URL? {
        switch source {
        case let .builtIn(name): StudioAssets.music.first { $0.id == name }?.url
        case let .file(file): workDirectory.appending(path: file)
        }
    }

    /// False when a newer choice was made while this one loaded; that choice's own load applies it.
    @discardableResult
    private func loadMusic() async -> Bool {
        let wanted = music
        guard let wanted, let url = musicURL(wanted.source) else {
            musicSource = nil
            musicWaveform = []
            return true
        }
        beginMedia()
        defer { endMedia() }
        let source = try? await StudioMusicSource.load(url: url, volume: wanted.volume, offset: wanted.offset)
        guard music == wanted else { return false }
        musicSource = source
        if loadedMusic?.url != url {
            let peaks = await Task.detached(priority: .utility) { await StudioWaveform.peaks(url: url, count: 160) }.value
            // A new volume for the same song still wants this song's waveform.
            if music?.source == wanted.source {
                musicWaveform = peaks
                loadedMusic = (wanted.source, url)
            }
        }
        return music == wanted
    }

    // MARK: Pending media

    private var mediaInFlight = 0
    private var mediaWaiters: [CheckedContinuation<Void, Never>] = []

    private func beginMedia() {
        mediaInFlight += 1
    }

    private func endMedia() {
        mediaInFlight -= 1
        guard mediaInFlight == 0 else { return }
        let waiters = mediaWaiters
        mediaWaiters = []
        for waiter in waiters { waiter.resume() }
    }

    /// A wallpaper or song picked a moment ago may still be loading; a render made now would leave it out.
    func waitForMedia() async {
        guard mediaInFlight > 0 else { return }
        await withCheckedContinuation { mediaWaiters.append($0) }
    }

    /// Lets a cancelled render stop waiting, however long the media takes.
    func stopWaitingForMedia() {
        let waiters = mediaWaiters
        mediaWaiters = []
        for waiter in waiters { waiter.resume() }
    }

    func pauseForExport() {
        if isPlaying {
            player.pause()
            isPlaying = false
        }
    }

    // MARK: Saving drafts

    @ObservationIgnored private var autosaveTask: Task<Void, Never>?

    /// Studio projects save themselves as they're edited; there's nothing to lose by closing.
    private func changed() {
        guard isStudio else { return }
        autosaveTask?.cancel()
        autosaveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled, let project = self?.project else { return }
            StudioSession.shared.save(project)
        }
    }

    func saveDraftNow() {
        autosaveTask?.cancel()
        if let project { StudioSession.shared.save(project) }
    }

    /// The edit at full quality with a look that no longer changes, for rendering while the editor carries on.
    func exportComposition() throws -> StudioComposition {
        let frozen = scene.frozen()
        return try StudioComposition.build(
            clips: timeline.clips,
            screen: screenSource,
            camera: cameraSource,
            music: musicSource,
            voiceVolume: voiceVolume,
            scene: frozen,
            longEdge: StudioLayout.exportLongEdge,
            remembersFrames: false
        )
    }

    // MARK: Trimming

    typealias Edge = TrimEdge
    /// Committed as one undo step when the finger lifts.
    private(set) var trimPreview: EditTimeline?
    private var trimMark: CFTimeInterval = 0

    var displayedTimeline: EditTimeline { trimPreview ?? timeline }

    func beginTrim() {
        clearStill()
        refreshStaleComposition()
        if isPlaying {
            player.pause()
            isPlaying = false
        }
        settleTask?.cancel()
        isTrimming = true
        trimPreview = timeline
        trimMark = CACurrentMediaTime()
    }

    func trim(clip index: Int, edge: Edge, toSource time: Double) {
        let base = timeline
        let next = edge == .start ? base.trimming(clipAt: index, start: time) : base.trimming(clipAt: index, end: time)
        trimPreview = next
        let shown = edge == .start ? next.clips[index].start : max(next.clips[index].start, next.clips[index].end - 1.0 / 30)
        scrubSeek(source: true, to: shown, metric: "trimFrameMs")
    }

    func endTrim(clip index: Int, edge: Edge) {
        settleTask?.cancel()
        cancelDetailThumbnails()
        isTrimming = false
        guard let next = trimPreview, next != timeline, next.clips.indices.contains(index) else {
            trimPreview = nil
            showsSource = false
            return
        }
        trimPreview = nil
        let starts = next.outputStarts
        let resumeAt = edge == .start ? starts[index] : starts[index] + next.clips[index].duration - 0.05
        apply(next, seekTo: max(0, resumeAt))
        metrics.record("trimGestureMs", (CACurrentMediaTime() - trimMark) * 1000)
    }

    // MARK: Saving

    /// Cuts to a Cap, saved and rendered by Cap. Styled edits go through `EditorExport` instead.
    func save() async -> Bool {
        guard hasChanges, !isSaving, !needsRender, let capId else { return false }
        isSaving = true
        defer { isSaving = false }
        do {
            try await session.api.saveEdit(capId, timeline: timeline)
            Usage.track("editor_saved", ["clips": .int(timeline.clips.count)])
            return true
        } catch {
            errorMessage = error == .conflict
                ? "An edit is already processing for this Cap. Try again when it's finished."
                : error.errorDescription
            return false
        }
    }

    func restoreOriginal() async -> Bool {
        guard let capId else { return false }
        isSaving = true
        defer { isSaving = false }
        do {
            try await session.api.restoreOriginal(capId)
            Usage.track("editor_restored")
            return true
        } catch {
            errorMessage = error == .conflict
                ? "An edit is already processing for this Cap. Try again when it's finished."
                : error.errorDescription
            return false
        }
    }

    private var closed = false

    func close() {
        guard !closed else { return }
        closed = true
        thumbnailTask?.cancel()
        detailTask?.cancel()
        itemReady?.invalidate()
        itemReady = nil
        for player in players { player.pause() }
        sourcePlayer.pause()
        removePlaybackObservers()
        saveDraftNow()
        scene.forgetFrames()
        for value in StudioCompositor.takeRenderTimes() { metrics.record("composeMs", value) }
        metrics.finish(sourceSeconds: timeline.sourceDuration, clips: timeline.clips.count)
    }

    private func removePlaybackObservers() {
        for (player, observer) in zip(players, timeObservers) { player.removeTimeObserver(observer) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        timeObservers = []
        endObserver = nil
    }

    enum EditorError: Error { case noVideo }
}

@MainActor
final class EditorMetrics {
    private var start: CFTimeInterval = 0
    private var mark = ProcessStats.mark()
    private var marks: [String: Double] = [:]
    private var samples: [String: [Double]] = [:]

    func begin() {
        start = CACurrentMediaTime()
        mark = ProcessStats.mark()
        marks = [:]
        samples = [:]
    }

    func mark(_ name: String) {
        guard marks[name] == nil else { return }
        marks[name] = (CACurrentMediaTime() - start) * 1000
    }

    func record(_ name: String, _ value: Double) {
        samples[name, default: []].append(value)
    }

    func finish(sourceSeconds: Double, clips: Int) {
        var extra = marks
        for (name, values) in samples where !values.isEmpty {
            let sorted = values.sorted()
            extra["\(name).count"] = Double(sorted.count)
            extra["\(name).p50"] = sorted[sorted.count / 2]
            extra["\(name).p95"] = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
            extra["\(name).max"] = sorted[sorted.count - 1]
        }
        extra["clips"] = Double(clips)
        let stats = ProcessStats.measure(since: mark, process: "editor", recordedSeconds: sourceSeconds, extra: extra)
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
              let line = try? JSONEncoder().encode(stats)
        else { return }
        let file = caches.appending(path: "EditorStats.jsonl")
        var lines = ((try? String(contentsOf: file, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
        lines.append(String(decoding: line, as: UTF8.self))
        try? (lines.suffix(20).joined(separator: "\n") + "\n").write(to: file, atomically: true, encoding: .utf8)
    }
}

extension EditorModel: Identifiable {}

#if DEBUG
/// Debug-only: `CAP_DEBUG_ROUTE=edit:<id>` opens a Cap and its editor; `CAP_DEBUG_EDITOR_SCRIPT=1` then runs a
/// fixed session and writes the stats.
@MainActor
enum EditorDebug {
    static var openOnLoad = false
    static var runsScript: Bool { ProcessInfo.processInfo.environment["CAP_DEBUG_EDITOR_SCRIPT"] == "1" }
}

extension EditorModel {
    /// Look changes as a person makes them: taps through backgrounds, a padding drag, the camera moved around,
    /// a new frame shape, music, playback, then a render.
    func runLookScript(pause: (Double) async -> Void) async {
        func memory(_ stage: String) {
            let footprint = ProcessStats.footprint()
            metrics.record("memoryMB.\(stage)", footprint.current)
            metrics.record("peakMB.\(stage)", footprint.peak)
        }
        memory("lookStart")
        seek(toOutput: timeline.outputDuration / 2)
        await pause(0.6)
        for background in StudioBackground.gradients.prefix(6) {
            setLook { $0.background = background }
            await pause(0.15)
        }
        beginLookGesture()
        for step in 0...40 {
            setLook { $0.padding = 0.15 * Double(step) / 40 }
            await pause(1.0 / 60)
        }
        endLookGesture()
        await pause(0.3)
        beginLookGesture()
        for step in 0...30 {
            setLook { $0.rounding = 0.12 * Double(step) / 30 }
            await pause(1.0 / 60)
        }
        endLookGesture()
        setLook { $0.background = .wallpaper("blue-1") }
        await pause(0.6)
        if hasCamera, hasScreen {
            for corner in StudioCorner.allCases {
                setLook { $0.camera.corner = corner }
                await pause(0.2)
            }
            for layout in [StudioCameraLayout.split, .cameraOnly, .bubble] {
                setLook { $0.camera.layout = layout }
                await pause(0.5)
            }
        }
        setLook { $0.aspect = .square }
        await pause(0.6)
        setLook { $0.aspect = .auto }
        await pause(0.6)
        memory("afterLooks")
        await setMusic(StudioMusic(source: .builtIn("lofi-beats-mirostar"), title: "Lofi Beats"))
        await pause(0.4)
        seek(toOutput: 0)
        await pause(0.3)
        togglePlay()
        await pause(4)
        if isPlaying { togglePlay() }
        memory("afterPlay")
        await pause(0.3)
        do {
            let built = try exportComposition()
            let url = FileManager.default.temporaryDirectory.appending(path: "studio-script-export.mp4")
            let result = try await StudioExporter().export(built, to: url)
            metrics.record("exportSeconds", result.seconds)
            metrics.record("exportRealtime", result.duration / max(result.seconds, 0.001))
            metrics.record("exportKbps", Double(result.bytes) * 8 / max(result.duration, 0.001) / 1000)
            memory("afterExport")
            ProcessStats.note("Studio script export \(Int(result.size.width))x\(Int(result.size.height)) \(String(format: "%.1f", result.duration)) s in \(String(format: "%.2f", result.seconds)) s, \(result.bytes / 1024) KB")
            try? FileManager.default.removeItem(at: url)
        } catch {
            ProcessStats.note("Studio script export failed: \(error)")
        }
    }
}

extension EditorModel {
    func runScript(onDone: @escaping () -> Void) async {
        func pause(_ seconds: Double) async { try? await Task.sleep(for: .seconds(seconds)) }
        while phase == .loading { await pause(0.05) }
        guard phase == .ready else { return }
        await pause(1.5)
        metrics.record("memoryMB.open", ProcessStats.footprint().current)
        metrics.record("peakMB.open", ProcessStats.footprint().peak)
        if ProcessInfo.processInfo.environment["CAP_DEBUG_EDITOR_SCRIPT_LOOK_ONLY"] == "1" {
            await runLookScript(pause: pause)
            onDone()
            return
        }
        let length = timeline.outputDuration
        seek(toOutput: length / 3)
        await pause(0.4)
        split()
        await pause(0.4)
        seek(toOutput: length * 2 / 3)
        await pause(0.4)
        split()
        await pause(0.4)
        selectedClip = 1
        deleteSelected()
        await pause(0.6)
        beginScrub()
        let steps = 90
        for step in 0...steps {
            scrub(toOutput: timeline.outputDuration * Double(step) / Double(steps))
            await pause(1.0 / 60)
        }
        endScrub()
        await pause(0.9)
        let first = timeline.clips[0]
        beginTrim()
        for step in 0...90 {
            trim(clip: 0, edge: .end, toSource: first.end - Double(step) * 0.05)
            await pause(1.0 / 60)
        }
        await pause(0.9)
        endTrim(clip: 0, edge: .end)
        await pause(0.5)
        undo()
        await pause(0.3)
        redo()
        await pause(0.3)
        seek(toOutput: 0)
        togglePlay()
        await pause(2)
        togglePlay()
        await runLookScript(pause: pause)
        ProcessStats.note("Editor script finished: \(timeline.clips.count) clips, \(timeline.outputDuration) s")
        onDone()
    }
}
#endif
