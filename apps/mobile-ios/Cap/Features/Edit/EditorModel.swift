import AVFoundation
import CapKit
import QuartzCore
import SwiftUI

/// The editor's state. Edits never render on the phone: the preview is an `AVMutableComposition` of the kept clips,
/// rebuilt in a few milliseconds per change, and Save sends the clip list to Cap, which renders the new version.
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

    private(set) var outputTime: Double = 0
    private(set) var isPlaying = false
    private(set) var isSaving = false
    var errorMessage: String?

    /// Filmstrip frames, evenly spaced across the source.
    private(set) var thumbnails: [UIImage] = []
    static let thumbnailCount = 24

    private var asset: AVURLAsset?
    private var videoTrack: AVAssetTrack?
    private var audioTrack: AVAssetTrack?
    private var assetDuration: CMTime = .zero
    private var videoTransform: CGAffineTransform = .identity
    private var timeObservers: [Any] = []
    private var rebuildGeneration = 0
    private var endObserver: NSObjectProtocol?
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
            self.asset = asset
            videoTrack = video
            audioTrack = audio
            metrics.mark("tracksLoaded")

            sourcePlayer.replaceCurrentItem(with: AVPlayerItem(asset: asset))
            try rebuild(seekTo: 0)
            observePlayback()
            phase = .ready
            loadThumbnails(asset: asset)
        } catch {
            phase = .failed((error as? CapAPIError)?.errorDescription ?? "Cap couldn't open this video for editing. Try again.")
        }
    }

    /// The MP4 Cap edits. Playback is an MP4 for every editable Cap; the download link covers anything else.
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

    /// The filmstrip frame nearest a source time.
    func thumbnail(atSource time: Double) -> UIImage? {
        guard !thumbnails.isEmpty, timeline.sourceDuration > 0 else { return nil }
        let index = Int((time / timeline.sourceDuration) * Double(thumbnails.count))
        return thumbnails[min(max(0, index), thumbnails.count - 1)]
    }

    // MARK: Composition

    /// Rebuilds the preview from the timeline. Only track references change, so building costs milliseconds; the
    /// new item loads on the hidden player and replaces the visible one when its first frame is ready.
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

        let wasPlaying = isPlaying
        let target = min(max(0, output), timeline.outputDuration)
        outputTime = target
        rebuildGeneration += 1
        let generation = rebuildGeneration
        // The first build has nothing on screen to keep, so it loads straight into the visible player.
        let next = player.currentItem == nil ? activePlayer : 1 - activePlayer
        let incoming = players[next]
        incoming.pause()
        incoming.replaceCurrentItem(with: item)
        incoming.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            Task { @MainActor in
                guard let self, finished, generation == self.rebuildGeneration else { return }
                let outgoing = self.players[self.activePlayer]
                self.activePlayer = next
                if outgoing !== incoming {
                    outgoing.pause()
                    outgoing.replaceCurrentItem(with: nil)
                }
                if wasPlaying { incoming.play() }
                self.metrics.record("rebuildToFrameMs", (CACurrentMediaTime() - started) * 1000)
            }
        }
    }

    /// Applies a timeline change, rebuilding the preview only when the video itself changes.
    private func show(_ next: EditTimeline, previous: EditTimeline, seekTo output: Double) {
        if next.playsSame(as: previous) {
            outputTime = min(max(0, output), next.outputDuration)
            return
        }
        try? rebuild(seekTo: output)
    }

    private func observePlayback() {
        timeObservers = players.enumerated().map { index, player in
            player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] time in
                MainActor.assumeIsolated {
                    guard let self, index == self.activePlayer, !self.isScrubbing, !self.isTrimming else { return }
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
    private var pendingSeek: (time: Double, exact: Bool)?
    private var seekIssuedAt: CFTimeInterval = 0
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

    /// While a finger moves, show the nearest earlier keyframe: it decodes on its own, so the picture keeps up. When the
    /// finger rests or lifts, one exact seek lands on the frame. Exact seeks on Cap's 250-frame GOPs decode up to
    /// eight seconds of video each, too slow to follow a drag.
    private func scrubSeek(source: Bool, to time: Double) {
        chaseSeek(source: source, to: time, exact: false)
        settle(source: source, to: time, after: 0.12)
    }

    private func settle(source: Bool, to time: Double, after delay: Double) {
        settleTask?.cancel()
        settleTask = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            guard !Task.isCancelled else { return }
            self?.chaseSeek(source: source, to: time, exact: true)
        }
    }

    /// One seek at a time; while one is running only the newest target is kept, so dragging never queues up.
    private func chaseSeek(source: Bool, to time: Double, exact: Bool) {
        let player = source ? sourcePlayer : self.player
        guard !seekInFlight else {
            // The newest target wins; the settle seek always comes last, so an exact landing is never lost.
            pendingSeek = (time, exact)
            return
        }
        seekInFlight = true
        seekIssuedAt = CACurrentMediaTime()
        let before: CMTime = exact ? .zero : .positiveInfinity
        player.seek(to: CMTime(seconds: time, preferredTimescale: 600), toleranceBefore: before, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.metrics.record(exact ? "settleMs" : "scrubFrameMs", (CACurrentMediaTime() - self.seekIssuedAt) * 1000)
                self.seekInFlight = false
                if let next = self.pendingSeek {
                    self.pendingSeek = nil
                    self.chaseSeek(source: source, to: next.time, exact: next.exact)
                }
            }
        }
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

    enum Edge { case start, end }
    /// The timeline as it looks mid-drag; committed as one undo step when the finger lifts.
    private(set) var trimPreview: EditTimeline?
    private var trimMark: CFTimeInterval = 0

    var displayedTimeline: EditTimeline { trimPreview ?? timeline }

    func beginTrim() {
        if isPlaying {
            player.pause()
            isPlaying = false
        }
        isTrimming = true
        trimPreview = timeline
        trimMark = CACurrentMediaTime()
    }

    /// Moves a clip edge to a source time and shows that frame from the untouched video.
    func trim(clip index: Int, edge: Edge, toSource time: Double) {
        let base = timeline
        let next = edge == .start ? base.trimming(clipAt: index, start: time) : base.trimming(clipAt: index, end: time)
        trimPreview = next
        let shown = edge == .start ? next.clips[index].start : max(next.clips[index].start, next.clips[index].end - 1.0 / 30)
        scrubSeek(source: true, to: shown)
    }

    func endTrim(clip index: Int, edge: Edge) {
        settleTask?.cancel()
        isTrimming = false
        guard let next = trimPreview else { return }
        trimPreview = nil
        guard next != timeline, next.clips.indices.contains(index) else { return }
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
        for player in players { player.pause() }
        sourcePlayer.pause()
        for (player, observer) in zip(players, timeObservers) { player.removeTimeObserver(observer) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        timeObservers = []
        endObserver = nil
        metrics.finish(sourceSeconds: timeline.sourceDuration, clips: timeline.clips.count)
    }

    enum EditorError: Error { case noVideo }
}

/// What opening and using the editor cost, kept in Caches/EditorStats.jsonl so device runs can be read back.
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

    /// Milliseconds since the editor opened, recorded the first time only.
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
/// Debug-only: `CAP_DEBUG_ROUTE=edit:<id>` opens a Cap and its editor; `CAP_DEBUG_EDITOR_SCRIPT=1` then runs a fixed
/// session (two splits, a delete, a fast scrub, a trim, undo and redo, a little playback) and writes the stats.
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
        await pause(0.4)
        let first = timeline.clips[0]
        beginTrim()
        for step in 0...20 {
            trim(clip: 0, edge: .end, toSource: first.end - Double(step) * 0.05)
            await pause(1.0 / 60)
        }
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
