@preconcurrency import AVFoundation
import CapKit
import Foundation
import notify
import os
import Synchronization
import ReplayKit
import UIKit
import UserNotifications

/// Runs in its own small process (about 50 MB), so it encodes in hardware and uploads segments as
/// they're made, so the link works the moment recording stops.
final class SampleHandler: RPBroadcastSampleHandler, @unchecked Sendable {
    private static let log = Logger(subsystem: "so.cap.mobile.broadcast", category: "screen")
    /// Static screens produce no frames; resend the last one so segments keep their two-second rhythm.
    private static let idleFrameInterval: TimeInterval = 0.5
    /// ReplayKit sends up to 60 frames a second; the recording is 30.
    private static let frameInterval = CMTime(value: 1, timescale: 30)
    private static let frameTolerance = CMTime(value: 8, timescale: 1000)

    private let queue = DispatchQueue(label: "so.cap.mobile.broadcast.writer", qos: .userInteractive)
    private let created = Mutex<RecordingHandoff.Entry?>(nil)

    // queue
    private var uploads: RecordingUploads?
    private var credentials: CredentialSnapshot?
    private var api: CapAPI?
    private var limit: TimeInterval?
    private var job: RecordingJob?
    private var writer: (any RecordingSink)?
    /// Set when Cap asked for a Studio recording: the screen is kept on the phone for editing, not uploaded.
    private var studio: (store: StudioStore, projectId: String)?
    private var audioSource: RPSampleBufferType?
    private var lastFrame: CMSampleBuffer?
    private var lastFrameAt: CMTime = .invalid
    private var nextFrameAt: CMTime = .zero
    private var idleTimer: DispatchSourceTimer?
    private var finishing = false
    private var stopToken: Int32 = NOTIFY_TOKEN_INVALID
    private var started = ProcessStats.mark()
    private var frames = 0
    private var repeatedFrames = 0

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        if let request = StudioScreenRequest.take(in: StudioStore.requests()) {
            let store = StudioStore.shared(owner: request.ownerId)
            queue.sync { studio = (store, request.projectId) }
            startIdleTimer()
            listenForStop()
            return
        }
        guard let environment = Self.environment() else {
            finish(message: "Cap couldn't start recording. Reinstall Cap and try again.")
            return
        }
        guard let credentials = KeychainCredentialStore(accessGroup: Self.keychainGroup).load() else {
            finish(message: "Open Cap and sign in, then start recording again.")
            return
        }
        let api = CapAPI(environment: environment, userAgent: "Cap-iOS-Broadcast", credentials: { credentials })
        // Shared with Cap, which finishes the upload once recording stops.
        let root = ScreenRecordingStore.root ?? FileManager.default.temporaryDirectory.appending(path: "CapRecordings", directoryHint: .isDirectory)
        // Uploads must finish inside this process: it's the only one awake while the user is elsewhere.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpMaximumConnectionsPerHost = 3
        configuration.timeoutIntervalForRequest = 60
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        let uploads = RecordingUploads(root: root, api: api, engine: UploadEngine(environment: environment), currentUserId: { credentials.userId }, configuration: configuration)
        queue.sync {
            self.credentials = credentials
            self.api = api
            self.uploads = uploads
        }
        Task { [weak self] in
            for await event in uploads.events {
                guard case let .created(_, capId, shareUrl) = event else { continue }
                self?.created.withLock { $0 = .init(capId: capId, shareUrl: shareUrl) }
            }
        }
        // Free until the plan says otherwise: going past the limit would lose the whole recording.
        queue.sync { limit = RecordingLimits.freeDuration }
        Task {
            guard (try? await api.plan())?.upgraded == true else { return }
            queue.async { self.limit = nil }
        }
        startIdleTimer()
        listenForStop()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        nonisolated(unsafe) let buffer = sampleBuffer
        queue.sync {
            guard !finishing else { return }
            switch sampleBufferType {
            case .video:
                appendFrame(buffer)
            case .audioMic, .audioApp:
                // One audio track: the microphone once it's heard from, otherwise app sound.
                if sampleBufferType == .audioMic { audioSource = .audioMic }
                if audioSource == nil { audioSource = sampleBufferType }
                if audioSource == sampleBufferType { writer?.appendAudio(buffer) }
            @unknown default:
                break
            }
        }
    }

    override func broadcastPaused() {}
    override func broadcastResumed() {}

    override func broadcastFinished() {
        let done = DispatchSemaphore(value: 0)
        queue.async { self.complete { done.signal() } }
        // The system gives the extension a few seconds here; the last segment and the completion
        // call normally take well under that.
        _ = done.wait(timeout: .now() + 8)
    }

    // MARK: Writing (queue)

    private func appendFrame(_ buffer: CMSampleBuffer, repeated: Bool = false) {
        let presentation = CMSampleBufferGetPresentationTimeStamp(buffer)
        if !repeated {
            guard presentation >= CMTimeSubtract(nextFrameAt, Self.frameTolerance) else { return }
            nextFrameAt = CMTimeMaximum(CMTimeAdd(nextFrameAt, Self.frameInterval), CMTimeSubtract(CMTimeAdd(presentation, Self.frameInterval), Self.frameTolerance))
        }
        if writer == nil, !start(with: buffer) { return }
        if repeated { repeatedFrames += 1 } else { frames += 1 }
        writer?.appendVideo(buffer)
        lastFrame = buffer
        lastFrameAt = presentation
        if studio != nil, (writer as? StudioTrackWriter)?.failed == true {
            complete { [weak self] in
                self?.finish(message: "Recording stopped because this iPhone is out of space. What was recorded is saved in Cap.")
            }
            return
        }
        if let limit, let writer, writer.duration >= limit {
            limitReached()
        }
    }

    /// Created on the first frame, when the screen's size is known.
    private func start(with buffer: CMSampleBuffer) -> Bool {
        if let studio {
            guard studio.store.hasRoomToRecord() else {
                finish(message: "Free up at least 1 GB on this iPhone to record in Studio Mode.")
                return false
            }
            do {
                let directory = studio.store.directory(for: studio.projectId)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                writer = try StudioTrackWriter(url: directory.appending(path: Self.studioScreenFile), settings: .init(kind: .screen, audio: true)) { started in
                    // Noted as soon as picture or sound starts: if this process is ended mid-recording, Cap can still recover it.
                    var pending = started
                    pending.duration = 0
                    pending.audio?.duration = 0
                    try? pending.save(as: "screen", in: directory)
                }
                return true
            } catch {
                finish(message: "Cap couldn't start recording your screen.")
                return false
            }
        }
        guard let uploads, let credentials, let pixels = CMSampleBufferGetImageBuffer(buffer) else { return false }
        // H.264 wants even dimensions.
        let width = CVPixelBufferGetWidth(pixels) & ~1
        let height = CVPixelBufferGetHeight(pixels) & ~1
        let format = SegmentWriter.VideoFormat(width: width, height: height, fps: 30, bitrate: Self.bitrate(width: width, height: height))
        let job = RecordingJob(
            userId: credentials.userId,
            title: "Screen Recording " + Date.now.formatted(.dateTime.day().month(.abbreviated).year().hour().minute()),
            format: .init(width: width, height: height, fps: 30),
            organizationId: nil,
            folderId: nil,
            hasAudio: true
        )
        do {
            let jobId = job.id
            writer = try SegmentWriter(
                directory: uploads.directory(for: jobId),
                video: format,
                audio: true,
                onSegment: { segment in uploads.add(segment, to: jobId) },
                onFailure: { [weak self] error in
                    Self.log.error("Writer failed: \(error.localizedDescription, privacy: .public)")
                    guard let self else { return }
                    queue.async {
                        self.complete { self.finish(message: "Recording stopped because the video couldn't be saved.") }
                    }
                }
            )
        } catch {
            finish(message: "Cap couldn't start recording your screen.")
            return false
        }
        self.job = job
        RecordingUploads.markActive(job.id, true)
        uploads.begin(job)
        return true
    }

    /// Screen content is mostly flat colour and text, so it needs far fewer bits than camera video.
    private static func bitrate(width: Int, height: Int) -> Int {
        min(8_000_000, max(2_500_000, width * height * 2))
    }

    private func startIdleTimer() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + Self.idleFrameInterval, repeating: Self.idleFrameInterval)
        timer.setEventHandler { [weak self] in self?.repeatLastFrameIfIdle() }
        timer.resume()
        idleTimer = timer
    }

    private func repeatLastFrameIfIdle() {
        guard !finishing, let lastFrame, lastFrameAt.isValid else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        guard CMTimeSubtract(now, lastFrameAt).seconds >= Self.idleFrameInterval,
              let repeated = SegmentWriter.retime(lastFrame, by: CMTimeSubtract(now, CMSampleBufferGetPresentationTimeStamp(lastFrame)))
        else { return }
        appendFrame(repeated, repeated: true)
    }

    private func listenForStop() {
        queue.sync {
            started = ProcessStats.mark()
            notify_register_dispatch(ScreenRecordingStop.notification, &stopToken, queue) { [weak self] _ in
                guard let self, ScreenRecordingStop.take(accessGroup: Self.keychainGroup) else { return }
                complete(handOff: true) { [weak self] in
                    self?.finish(message: "Your recording is saved in Cap.")
                }
            }
        }
    }

    private func limitReached() {
        complete { [weak self] in
            self?.finish(message: "Stopped at 5 minutes, the free plan limit. Your recording is saved in Cap. Cap Pro has no limit.")
        }
    }

    /// Stopped from Cap, which is in front, the rest of the upload is handed to Cap so recording ends at once.
    private func complete(handOff: Bool = false, _ done: @escaping @Sendable () -> Void) {
        guard !finishing else {
            done()
            return
        }
        finishing = true
        idleTimer?.cancel()
        idleTimer = nil
        notify_cancel(stopToken)
        lastFrame = nil
        if let studio {
            completeStudio(studio, handOff: handOff, done)
            return
        }
        guard let writer, let job, let uploads else {
            done()
            return
        }
        self.writer = nil
        let jobId = job.id
        let counts = (frames: frames, repeated: repeatedFrames, started: started)
        // Stopped outside Cap, which can't bring itself forward: the way back is this
        // notification, so it goes out now rather than once the upload is done.
        let entry = handOff ? nil : created.withLock { $0 }
        if !handOff {
            if let entry { UIPasteboard.general.string = entry.shareUrl }
            Task { await Self.notifySaved(entry) }
        }
        // Held to the moment it stopped: a still screen sends no frames.
        writer.finish(at: CMClockGetTime(CMClockGetHostTimeClock())) { result in
            defer { RecordingUploads.markActive(jobId, false) }
            let duration = (try? result.get()) ?? uploads.job(jobId).flatMap(RecordingUploads.recordedDuration) ?? 0
            ProcessStats.measure(since: counts.started, process: "broadcast", recordedSeconds: duration, extra: [
                "frames": Double(counts.frames),
                "repeatedFrames": Double(counts.repeated),
            ]).save()
            guard duration >= 1 else {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [Self.notificationId])
                Task {
                    if let capId = await uploads.discard(jobId).flatMap(CapID.init) { try? await self.api?.deleteCap(capId) }
                    done()
                }
                return
            }
            Task {
                if handOff {
                    await uploads.handOff(jobId, durationSeconds: duration)
                    ScreenRecordingStore.postHandOff()
                    done()
                    return
                }
                uploads.finish(jobId, durationSeconds: duration)
                // Usually one or two small segments and a single request.
                for _ in 0..<50 where uploads.job(jobId) != nil {
                    try? await Task.sleep(for: .milliseconds(100))
                }
                // Let a completion call that's under way land rather than make Cap repeat it.
                for _ in 0..<20 where uploads.job(jobId)?.phase == .completing {
                    try? await Task.sleep(for: .milliseconds(100))
                }
                var outcome = RecordingHandoff.Outcome.uploaded
                if uploads.job(jobId) != nil {
                    // The upload can still finish between that check and this call, which then has nothing to take.
                    // What was taken says how it ended here: Cap never hears about a failure it only adopts.
                    switch await uploads.handOff(jobId, durationSeconds: duration) {
                    case nil: outcome = .uploaded
                    case .failed: outcome = .failed
                    default: outcome = .handedOver
                    }
                    ScreenRecordingStore.postHandOff()
                }
                if let entry = entry ?? self.created.withLock({ $0 }) {
                    // Cap shows it next time it's in front.
                    RecordingHandoff.save(.init(capId: entry.capId, shareUrl: entry.shareUrl, outcome: outcome, durationSeconds: duration), accessGroup: Self.keychainGroup)
                }
                done()
            }
        }
    }

    private static let notificationId = "so.cap.mobile.screen-recording"
    private static let studioScreenFile = "screen.mp4"

    /// Studio recordings finish on the phone: close the file, note when it started, and tell Cap it's there.
    private func completeStudio(_ studio: (store: StudioStore, projectId: String), handOff: Bool, _ done: @escaping @Sendable () -> Void) {
        guard let writer = writer as? StudioTrackWriter else {
            done()
            return
        }
        self.writer = nil
        let directory = studio.store.directory(for: studio.projectId)
        let counts = (frames: frames, repeated: repeatedFrames, started: started)
        writer.finish(at: CMClockGetTime(CMClockGetHostTimeClock())) { result in
            let duration = (try? result.get()) ?? 0
            ProcessStats.measure(since: counts.started, process: "broadcast-studio", recordedSeconds: duration, extra: [
                "frames": Double(counts.frames),
                "repeatedFrames": Double(counts.repeated),
            ]).save()
            if var info = writer.info {
                if duration > 0 { info.duration = duration }
                try? info.save(as: "screen", in: directory)
            }
            notify_post(StudioScreenRequest.finishedNotification)
            if !handOff {
                Task { await Self.notifyStudioSaved(projectId: studio.projectId) }
            }
            done()
        }
    }

    private static func notifyStudioSaved(projectId: String) async {
        let content = UNMutableNotificationContent()
        content.title = "Your Studio recording is ready"
        content.body = "Tap to edit it in Cap."
        content.userInfo = ["studioProject": projectId]
        content.interruptionLevel = .active
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: notificationId, content: content, trigger: nil))
    }

    private static func notifySaved(_ entry: RecordingHandoff.Entry?) async {
        let content = UNMutableNotificationContent()
        content.title = "Your recording is saved"
        if let entry {
            content.body = "Link copied. Tap to open Cap."
            content.userInfo = ["capId": entry.capId]
        } else {
            content.body = "Tap to open Cap, where it's uploading."
        }
        content.interruptionLevel = .active
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: notificationId, content: content, trigger: nil))
    }

    private func finish(message: String) {
        finishBroadcastWithError(NSError(domain: "so.cap.mobile.broadcast", code: 1, userInfo: [NSLocalizedDescriptionKey: message]))
    }

    // MARK: Configuration

    private static var keychainGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "CapKeychainGroup") as? String
    }

    private static func environment() -> CapEnvironment? {
        guard let configured = Bundle.main.object(forInfoDictionaryKey: "CapAPIBaseURL") as? String else { return nil }
        #if DEBUG
        return CapEnvironment(string: configured, allowInsecureLocalhost: true)
        #else
        return CapEnvironment(string: configured, allowInsecureLocalhost: false)
        #endif
    }
}
