@preconcurrency import AVFoundation
import CapKit
import Foundation
import os
import Synchronization

/// All capture state lives on `sessionQueue`; all sample handling on `outputQueue`.
nonisolated final class CameraCapture: NSObject, @unchecked Sendable, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    enum Event: Sendable {
        case running
        case interrupted
        case resumed
        case failed(String)
    }

    enum SetupError: Error, LocalizedError {
        case noCamera

        var errorDescription: String? { "This device's camera isn't available." }
    }

    /// Sharp for faces and light enough to upload while recording on cellular.
    static let format = SegmentWriter.VideoFormat(width: 1080, height: 1920, fps: 30, bitrate: 4_000_000)

    struct Configuration: Sendable {
        let preset: AVCaptureSession.Preset
        let mirrored: Bool
        let multitasking: Bool

        static let recorder = Configuration(preset: .hd1920x1080, mirrored: false, multitasking: false)
        /// Small, since it's only ever shown in a floating window.
        static let bubble = Configuration(preset: .vga640x480, mirrored: true, multitasking: true)
    }

    private static let log = Logger(subsystem: "so.cap.mobile", category: "recorder")

    let session = AVCaptureSession()
    private let configuration: Configuration
    private let sessionQueue = DispatchQueue(label: "so.cap.mobile.capture.session", qos: .userInitiated)
    private let outputQueue = DispatchQueue(label: "so.cap.mobile.capture.output", qos: .userInteractive)
    private let videoOutput = AVCaptureVideoDataOutput()
    private let audioOutput = AVCaptureAudioDataOutput()

    // sessionQueue
    private var videoInput: AVCaptureDeviceInput?
    private var configured = false
    private var observers: [NSObjectProtocol] = []
    #if DEBUG
    private var fileSource: DebugFileSource?
    #endif

    // outputQueue
    private var writer: SegmentWriter?

    var onEvent: (@Sendable (Event) -> Void)?
    var onFrame: (@Sendable (CMSampleBuffer) -> Void)?

    init(configuration: Configuration = .recorder) {
        self.configuration = configuration
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    // MARK: Session

    /// Safe to call again; later calls only restart it.
    func start(position: AVCaptureDevice.Position, microphone: Bool, completion: @escaping @Sendable (Result<Bool, any Error>) -> Void) {
        sessionQueue.async { [self] in
            #if DEBUG
            if let file = DebugFileSource.configuredFile {
                if fileSource == nil {
                    let source = DebugFileSource(file: file, queue: outputQueue) { [weak self] buffer, isVideo in
                        self?.handle(buffer, isVideo: isVideo)
                    }
                    fileSource = source
                    source.start()
                }
                completion(.success(true))
                onEvent?(.running)
                return
            }
            #endif
            do {
                if !configured {
                    try configure(position: position, microphone: microphone)
                    configured = true
                }
                if !session.isRunning { session.startRunning() }
                completion(.success(session.inputs.contains { ($0 as? AVCaptureDeviceInput)?.device.hasMediaType(.audio) == true }))
                onEvent?(.running)
            } catch {
                completion(.failure(error))
            }
        }
    }

    func stop() {
        sessionQueue.async { [self] in
            #if DEBUG
            fileSource?.stop()
            fileSource = nil
            #endif
            if session.isRunning { session.stopRunning() }
        }
    }

    private func configure(position: AVCaptureDevice.Position, microphone: Bool) throws {
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        if session.canSetSessionPreset(configuration.preset) {
            session.sessionPreset = configuration.preset
        } else {
            session.sessionPreset = .high
        }
        try attachCamera(position)
        if microphone, let mic = AVCaptureDevice.default(for: .audio), let input = try? AVCaptureDeviceInput(device: mic), session.canAddInput(input) {
            session.addInput(input)
        }

        videoOutput.alwaysDiscardsLateVideoFrames = true
        // The encoder's native format, so frames go straight in without conversion.
        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        videoOutput.setSampleBufferDelegate(self, queue: outputQueue)
        if session.canAddOutput(videoOutput) { session.addOutput(videoOutput) }
        if microphone {
            audioOutput.setSampleBufferDelegate(self, queue: outputQueue)
            if session.canAddOutput(audioOutput) { session.addOutput(audioOutput) }
        }
        if configuration.multitasking, session.isMultitaskingCameraAccessSupported {
            session.isMultitaskingCameraAccessEnabled = true
        }
        orientVideoConnection()
        observe()
    }

    private func attachCamera(_ position: AVCaptureDevice.Position) throws {
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
            ?? AVCaptureDevice.default(for: .video)
        else { throw SetupError.noCamera }
        let input = try AVCaptureDeviceInput(device: camera)
        if let videoInput { session.removeInput(videoInput) }
        guard session.canAddInput(input) else {
            if let videoInput { session.addInput(videoInput) }
            throw SetupError.noCamera
        }
        session.addInput(input)
        videoInput = input

        try camera.lockForConfiguration()
        if camera.isFocusModeSupported(.continuousAutoFocus) { camera.focusMode = .continuousAutoFocus }
        if camera.isExposureModeSupported(.continuousAutoExposure) { camera.exposureMode = .continuousAutoExposure }
        // A steady 30 fps, so the encoder's rate and the segment cuts stay predictable.
        let frame = CMTime(value: 1, timescale: 30)
        if camera.activeFormat.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= 30 && $0.maxFrameRate >= 30 }) {
            camera.activeVideoMinFrameDuration = frame
            camera.activeVideoMaxFrameDuration = frame
        }
        camera.unlockForConfiguration()
    }

    private func orientVideoConnection() {
        guard let connection = videoOutput.connection(with: .video) else { return }
        if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
        // Recorded the way viewers see the person, so text held up to the camera reads correctly.
        if connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = configuration.mirrored && videoInput?.device.position == .front
        }
        if connection.isVideoStabilizationSupported {
            connection.preferredVideoStabilizationMode = .standard
        }
    }

    func flip(completion: @escaping @Sendable (AVCaptureDevice.Position) -> Void) {
        sessionQueue.async { [self] in
            guard configured, let current = videoInput?.device.position else { return }
            let next: AVCaptureDevice.Position = current == .front ? .back : .front
            session.beginConfiguration()
            do {
                try attachCamera(next)
            } catch {
                Self.log.error("Camera flip failed: \(error.localizedDescription, privacy: .public)")
            }
            orientVideoConnection()
            session.commitConfiguration()
            completion(videoInput?.device.position ?? current)
        }
    }

    private func observe() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: nil) { [weak self] _ in
            self?.onEvent?(.interrupted)
        })
        observers.append(center.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: nil) { [weak self] _ in
            self?.onEvent?(.resumed)
        })
        observers.append(center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] note in
            guard let self else { return }
            let error = note.userInfo?[AVCaptureSessionErrorKey] as? AVError
            if error?.code == .mediaServicesWereReset {
                sessionQueue.async { if !self.session.isRunning { self.session.startRunning() } }
            } else {
                onEvent?(.failed(error?.localizedDescription ?? "The camera stopped unexpectedly."))
            }
        })
    }

    // MARK: Recording

    func beginRecording(_ writer: SegmentWriter) {
        outputQueue.async { self.writer = writer }
    }

    func endRecording(_ completion: @escaping @Sendable (Result<Double, any Error>) -> Void) {
        outputQueue.async { [self] in
            guard let writer else {
                completion(.success(0))
                return
            }
            self.writer = nil
            writer.finish(completion)
        }
    }

    func cancelRecording() {
        outputQueue.async { [self] in
            writer?.cancel()
            writer = nil
        }
    }

    func recordedDuration(_ completion: @escaping @Sendable (Double) -> Void) {
        outputQueue.async { [self] in completion(writer?.duration ?? 0) }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        handle(sampleBuffer, isVideo: output === videoOutput)
    }

    private func handle(_ buffer: CMSampleBuffer, isVideo: Bool) {
        if isVideo { onFrame?(buffer) }
        guard let writer, CMSampleBufferDataIsReady(buffer) else { return }
        if isVideo {
            writer.appendVideo(buffer)
        } else {
            writer.appendAudio(buffer)
        }
    }
}

#if DEBUG
/// Lets the simulator, which has no camera, exercise the real encoder, segmenting and upload path.
/// Set `CAP_DEBUG_RECORDER_FILE`.
nonisolated final class DebugFileSource: @unchecked Sendable {
    static var configuredFile: URL? {
        ProcessInfo.processInfo.environment["CAP_DEBUG_RECORDER_FILE"].map { URL(fileURLWithPath: $0) }
    }

    private let file: URL
    private let queue: DispatchQueue
    private let deliver: (CMSampleBuffer, Bool) -> Void
    private let running = Atomic<Bool>(false)

    init(file: URL, queue: DispatchQueue, deliver: @escaping (CMSampleBuffer, Bool) -> Void) {
        self.file = file
        self.queue = queue
        self.deliver = deliver
    }

    func start() {
        running.store(true, ordering: .relaxed)
        Task.detached { [self] in await loop(video: true) }
        Task.detached { [self] in await loop(video: false) }
    }

    func stop() {
        running.store(false, ordering: .relaxed)
    }

    private func loop(video: Bool) async {
        let asset = AVURLAsset(url: file)
        let start = CMClockGetTime(CMClockGetHostTimeClock())
        var base = CMTime.zero
        var lastDue = CMTime.invalid
        while running.load(ordering: .relaxed) {
            guard let reader = try? AVAssetReader(asset: asset),
                  let track = try? await asset.loadTracks(withMediaType: video ? .video : .audio).first
            else { return }
            let settings: [String: Any] = video
                ? [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
                : [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false]
            let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
            output.alwaysCopiesSampleData = false
            reader.add(output)
            reader.startReading()
            var last = CMTime.zero
            while running.load(ordering: .relaxed), let buffer = output.copyNextSampleBuffer() {
                let pts = CMSampleBufferGetPresentationTimeStamp(buffer)
                // Decoders leave the last frame's duration unset.
                let duration = CMSampleBufferGetDuration(buffer)
                last = CMTimeAdd(pts, duration.isValid ? duration : CMTime(value: 1, timescale: 30))
                let due = CMTimeAdd(start, CMTimeAdd(base, pts))
                let wait = CMTimeSubtract(due, CMClockGetTime(CMClockGetHostTimeClock())).seconds
                if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
                // Encoder priming can give a loop's first audio a negative time; keep time moving forward.
                if lastDue.isValid, due <= lastDue { continue }
                lastDue = due
                if let retimed = SegmentWriter.retime(buffer, by: CMTimeSubtract(due, pts)) {
                    nonisolated(unsafe) let sample = retimed
                    queue.async { self.deliver(sample, video) }
                }
            }
            base = CMTimeAdd(base, last)
        }
    }
}
#endif
