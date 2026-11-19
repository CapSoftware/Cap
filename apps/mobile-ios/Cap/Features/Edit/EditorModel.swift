import AVFoundation
import CapKit
import QuartzCore
import SwiftUI

/// Edits never render on the phone: the preview is an `AVMutableComposition` of the kept clips, rebuilt
/// in a few milliseconds per change, and Cap renders the saved version.
@MainActor
@Observable
final class EditorModel {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    let capId: CapID
    let title: String
    let state: CapEditState
    private let session: SessionModel

    private(set) var phase: Phase = .loading
    private(set) var timeline: EditTimeline
    private(set) var undoStack: [EditTimeline] = []
    private(set) var redoStack: [EditTimeline] = []
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

    private var asset: AVURLAsset?
    private var videoTrack: AVAssetTrack?
    private var audioTrack: AVAssetTrack?
    private var assetDuration: CMTime = .zero
    private var videoTransform: CGAffineTransform = .identity
    private var timeObservers: [Any] = []
    private var rebuildGeneration = 0
    private var endObserver: NSObjectProtocol?
    private var itemReady: NSKeyValueObservation?
    private var rebuildPending = false
    private var thumbnailTask: Task<Void, Never>?
    let metrics = EditorMetrics()

    private let preloaded: AVURLAsset?

    init(capId: CapID, title: String, state: CapEditState, session: SessionModel, preloaded: AVURLAsset? = nil) {
        self.preloaded = preloaded
        self.capId = capId
        self.title = title
        self.state = state
        self.session = session
        timeline = EditTimeline(sourceDuration: state.duration)
        for player in players { player.automaticallyWaitsToMinimizeStalling = false }
        sourcePlayer.automaticallyWaitsToMinimizeStalling = false
    }

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }
    var hasChanges: Bool { !timeline.isUnchanged }
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
            let asset: AVURLAsset
            if let preloaded {
                asset = preloaded
                metrics.mark("reusedPlayback")
            } else {
                asset = AVURLAsset(url: try await sourceURL(), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
            }
            async let videoTracks = asset.loadTracks(withMediaType: .video)
            async let audioTracks = asset.loadTracks(withMediaType: .audio)
            async let duration = asset.load(.duration)
            guard let video = try await videoTracks.first else { throw EditorError.noVideo }
            let audio = try await audioTracks.first
            assetDuration = try await duration
            videoTransform = (try? await video.load(.preferredTransform)) ?? .identity
            if let size = try? await video.load(.naturalSize).applying(videoTransform), size.height != 0 {
                videoAspect = min(max(abs(size.width / size.height), 0.4), 2.4)
            }
            self.asset = asset
            videoTrack = video
            audioTrack = audio
            metrics.mark("tracksLoaded")

            sourcePlayer.replaceCurrentItem(with: AVPlayerItem(asset: asset))
            try rebuild(seekTo: 0)
            observePlayback()
            phase = .ready
            Usage.screen("editor")
            loadThumbnails(asset: asset)
        } catch {
            phase = .failed((error as? CapAPIError)?.errorDescription ?? "Cap couldn't open this video for editing. Try again.")
        }
    }

    /// Playback is an MP4 for every editable Cap; the download link covers anything else.
    private func sourceURL() async throws -> URL {
        let environment = session.services.environment
        let playback = try await session.api.playback(capId)
        if playback.kind == .mp4, let url = SafeURL.media(playback.url, environment: environment) { return url }
        let download = try await session.api.download(capId)
        guard let url = SafeURL.media(download.url, environment: environment) else { throw EditorError.noVideo }
        return url
    }

    private func loadThumbnails(asset: AVURLAsset) {
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
            let times = (0..<Self.thumbnailCount).map { index in
                CMTime(seconds: duration * (Double(index) + 0.5) / Double(Self.thumbnailCount), preferredTimescale: 600)
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
        guard let asset, timeline.sourceDuration > 0 else { return }
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
            let times = wanted.map { CMTime(seconds: (Double($0) + 0.5) * step, preferredTimescale: 600) }
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
        guard let videoTrack else { return }
        let started = CACurrentMediaTime()
        let composition = AVMutableComposition()
        guard let video = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw EditorError.noVideo
        }
        let audio = audioTrack == nil ? nil : composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        var cursor = CMTime.zero
        for clip in timeline.clips {
            let start = CMTime(seconds: clip.start, preferredTimescale: 600)
            let end = CMTimeMinimum(CMTime(seconds: clip.end, preferredTimescale: 600), assetDuration)
            guard end > start else { continue }
            let range = CMTimeRange(start: start, end: end)
            try video.insertTimeRange(range, of: videoTrack, at: cursor)
            if let audio, let audioTrack {
                try? audio.insertTimeRange(range, of: audioTrack, at: cursor)
            }
            cursor = cursor + range.duration
        }
        video.preferredTransform = videoTransform
        let item = AVPlayerItem(asset: composition)
        item.preferredForwardBufferDuration = 2
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
            if outputTime >= timeline.outputDuration - 0.05 { seek(toOutput: 0) }
            player.play()
            isPlaying = true
        }
    }

    private(set) var isScrubbing = false
    private var seekInFlight = false
    private var pendingSeek: Seek?
    private var settleTask: Task<Void, Never>?

    func beginScrub() {
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
        undoStack.append(timeline)
        redoStack.removeAll()
        timeline = next
        show(next, previous: previous, seekTo: output)
        metrics.record("editMs", (CACurrentMediaTime() - started) * 1000)
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
        redoStack.append(timeline)
        let source = timeline.sourceTime(forOutput: outputTime)
        let current = timeline
        timeline = previous
        selectedClip = nil
        show(previous, previous: current, seekTo: previous.outputTime(forSource: source))
    }

    func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(timeline)
        let source = timeline.sourceTime(forOutput: outputTime)
        let current = timeline
        timeline = next
        selectedClip = nil
        show(next, previous: current, seekTo: next.outputTime(forSource: source))
    }

    // MARK: Trimming

    typealias Edge = TrimEdge
    /// Committed as one undo step when the finger lifts.
    private(set) var trimPreview: EditTimeline?
    private var trimMark: CFTimeInterval = 0

    var displayedTimeline: EditTimeline { trimPreview ?? timeline }

    func beginTrim() {
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

    func save() async -> Bool {
        guard hasChanges, !isSaving else { return false }
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
    func runScript(onDone: @escaping () -> Void) async {
        func pause(_ seconds: Double) async { try? await Task.sleep(for: .seconds(seconds)) }
        while phase == .loading { await pause(0.05) }
        guard phase == .ready else { return }
        await pause(1.5)
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
        ProcessStats.note("Editor script finished: \(timeline.clips.count) clips, \(timeline.outputDuration) s")
        onDone()
    }
}
#endif
