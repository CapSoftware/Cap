@preconcurrency import AVFoundation
import CapKit
import Observation
import os
import UIKit

@MainActor
@Observable
final class RecordModel {
    enum Phase: Equatable {
        case preparing
        case cameraDenied
        case unavailable(String)
        case ready
        case recording(startedAt: Date)
        case finishing
    }

    private static let log = Logger(subsystem: "so.cap.mobile", category: "recorder")
    /// Shorter than this is almost always an accidental tap.
    static let minimumDuration: TimeInterval = 1

    private(set) var phase: Phase = .preparing
    private(set) var position: AVCaptureDevice.Position = .front
    private(set) var hasMicrophone = false
    private(set) var isFlipping = false

    @ObservationIgnored let capture = CameraCapture()
    @ObservationIgnored private let session: SessionModel
    @ObservationIgnored private let folderId: String?
    @ObservationIgnored private var jobId: String?
    @ObservationIgnored private var limitTask: Task<Void, Never>?
    @ObservationIgnored private var stopping = false
    @ObservationIgnored private var wantsCamera = true

    init(session: SessionModel, folderId: String?) {
        self.session = session
        self.folderId = folderId
        capture.onEvent = { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
    }

    private var isUnavailable: Bool {
        if case .unavailable = phase { return true }
        return false
    }

    var isRecording: Bool {
        if case .recording = phase { return true }
        return false
    }

    var limit: TimeInterval? { session.isPro ? nil : RecordingLimits.freeDuration }
    var upgradeURL: URL { session.services.environment.upgradeURL }

    // MARK: Camera

    func prepare() async {
        wantsCamera = true
        // The free plan's limit is enforced while recording; make sure a Pro plan is known by then.
        if session.plan == nil { Task { await session.refreshPlan() } }
        guard phase == .preparing || phase == .cameraDenied || isUnavailable else { return }
        #if DEBUG
        if DebugFileSource.configuredFile != nil {
            await startCapture(microphone: true)
            return
        }
        #endif
        guard await Self.requestAccess(.video) else {
            phase = .cameraDenied
            return
        }
        let microphone = await Self.requestAccess(.audio)
        await startCapture(microphone: microphone)
    }

    private func startCapture(microphone: Bool) async {
        let position = position
        let result = await withCheckedContinuation { continuation in
            capture.start(position: position, microphone: microphone) { continuation.resume(returning: $0) }
        }
        switch result {
        case let .success(hasMicrophone):
            self.hasMicrophone = hasMicrophone
            // Switched to screen mode while the camera was starting.
            guard wantsCamera else {
                capture.stop()
                return
            }
            phase = .ready
        case let .failure(error):
            phase = .unavailable(error.localizedDescription)
        }
    }

    private static func requestAccess(_ type: AVMediaType) async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: type) {
        case .authorized: true
        case .notDetermined: await AVCaptureDevice.requestAccess(for: type)
        default: false
        }
    }

    func pauseCamera() {
        wantsCamera = false
        guard phase == .ready else { return }
        capture.stop()
        phase = .preparing
    }

    func flip() {
        guard !isFlipping, phase == .ready || isRecording else { return }
        isFlipping = true
        capture.flip { [weak self] position in
            Task { @MainActor in
                self?.position = position
                self?.isFlipping = false
            }
        }
    }

    func teardown() {
        if isRecording { discard() }
        capture.stop()
    }

    // MARK: Recording

    func record() {
        guard phase == .ready else { return }
        let recordings = session.services.recordings
        let job = RecordingJob(
            userId: session.credentials.userId,
            title: Self.title(for: .now),
            format: .init(width: CameraCapture.format.width, height: CameraCapture.format.height, fps: CameraCapture.format.fps),
            organizationId: session.organizationId,
            folderId: folderId,
            hasAudio: hasMicrophone
        )
        let jobId = job.id
        let writer: SegmentWriter
        do {
            writer = try SegmentWriter(
                directory: recordings.directory(for: jobId),
                video: CameraCapture.format,
                audio: hasMicrophone,
                onSegment: { segment in recordings.add(segment, to: jobId) },
                onFailure: { [weak self] error in
                    Task { @MainActor in self?.writerFailed(error) }
                }
            )
        } catch {
            session.toasts.show(error: error)
            return
        }
        self.jobId = jobId
        stopping = false
        RecordingUploads.markActive(jobId, true)
        RecordingCoordinator.shared.activeModel = self
        // The Cap is created while the first frames are being encoded.
        recordings.begin(job)
        capture.beginRecording(writer)
        phase = .recording(startedAt: .now)
        Usage.track("recording_started", ["mode": "camera", "microphone": .bool(hasMicrophone)])
        UIApplication.shared.isIdleTimerDisabled = true
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        if let limit {
            limitTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(limit))
                guard !Task.isCancelled else { return }
                self?.session.toasts.show("Stopped at 5 minutes, the free plan limit. Cap Pro has no limit.", systemImage: "clock.fill", style: .info)
                await self?.stop()
            }
        }
    }

    func stop() async {
        guard isRecording, !stopping, let jobId else { return }
        stopping = true
        limitTask?.cancel()
        phase = .finishing
        UIApplication.shared.isIdleTimerDisabled = false
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let recordings = session.services.recordings
        let result = await withCheckedContinuation { continuation in
            capture.endRecording { continuation.resume(returning: $0) }
        }
        let duration: Double
        switch result {
        case let .success(value):
            duration = value
        case let .failure(error):
            Self.log.error("Recording ended with an error: \(error.localizedDescription, privacy: .public)")
            // Keep whatever reached the disk.
            duration = recordings.job(jobId).flatMap(RecordingUploads.recordedDuration) ?? 0
        }
        guard duration >= Self.minimumDuration else {
            Usage.track("recording_discarded", ["mode": "camera", "reason": "too_short"])
            RecordingUploads.markActive(jobId, false)
            session.toasts.show("Recording was too short", systemImage: "record.circle", style: .info)
            await throwAway(jobId)
            phase = .ready
            return
        }
        // Hand over before clearing the active flag, or a resume pass in between would treat it as a crash.
        recordings.finish(jobId, durationSeconds: duration)
        Usage.track("recording_stopped", ["mode": "camera", "duration_seconds": .int(Int(duration.rounded()))])
        RecordingUploads.markActive(jobId, false)
        self.jobId = nil
        // Shown if the user leaves before the last seconds finish uploading.
        let job = recordings.job(jobId)
        UploadActivities.shared.start(id: jobId, title: job?.title ?? "Recording", kind: .recording, phase: .uploading, capId: job?.capId)
        // Stays on the recorder: the upload carries on in the list while the next one is recorded.
        RecentRecordings.shared.stopped(jobId: jobId, kind: .camera)
        RecordingCoordinator.shared.cameraRecordingStopped()
        phase = .ready
    }

    func discard() {
        guard isRecording || phase == .finishing, let jobId else { return }
        Usage.track("recording_discarded", ["mode": "camera", "reason": "cancelled"])
        limitTask?.cancel()
        UIApplication.shared.isIdleTimerDisabled = false
        capture.cancelRecording()
        RecordingUploads.markActive(jobId, false)
        phase = .ready
        Task { await throwAway(jobId) }
    }

    private func throwAway(_ jobId: String) async {
        self.jobId = nil
        let capId = await session.services.recordings.discard(jobId)
        if let id = capId.flatMap(CapID.init) {
            try? await session.api.deleteCap(id)
        }
    }

    private func writerFailed(_ error: any Error) {
        Self.log.error("Writer failed: \(String(describing: error), privacy: .public)")
        session.toasts.show(error: error)
        Task { await stop() }
    }

    private func handle(_ event: CameraCapture.Event) {
        switch event {
        case .running, .resumed:
            break
        case .interrupted:
            // The camera can't record in the background or during a call. Keep what was recorded.
            if isRecording { Task { await stop() } }
        case let .failed(message):
            if isRecording { Task { await stop() } } else { phase = .unavailable(message) }
        }
    }

    func uploadFailed(jobId: String) {
        guard jobId == self.jobId, isRecording else { return }
        discard()
    }

    static func title(for date: Date) -> String {
        "Cap Recording " + date.formatted(.dateTime.day().month(.abbreviated).year().hour().minute())
    }
}
