@preconcurrency import AVFoundation
import Foundation
import Synchronization

/// Renders a composition to an H.264 MP4 at a bitrate chosen for sharing. `AVAssetExportSession` has no bitrate
/// control and its high-quality presets make files several times larger than a link needs.
public final class StudioExporter: @unchecked Sendable {
    public enum Failure: Error, LocalizedError {
        case cantRead
        case cantWrite
        case cancelled

        public var errorDescription: String? {
            switch self {
            case .cantRead, .cantWrite: "Cap couldn't render this video. Try again."
            case .cancelled: "Rendering was cancelled."
            }
        }
    }

    public struct Result: Sendable {
        public let url: URL
        public let duration: Double
        public let seconds: Double
        public let bytes: Int64
        public let size: CGSize
    }

    /// About 0.1 bits per pixel per frame: crisp for screen text and faces at 30 fps.
    public static func bitrate(for size: CGSize, fps: Double = 30) -> Int {
        Int(min(16_000_000, max(2_000_000, size.width * size.height * fps * 0.1)))
    }

    private let cancelled = Flag()
    private var reader: AVAssetReader?
    private var writer: AVAssetWriter?
    private var pumps: Pumps?

    public init() {}

    public func cancel() {
        _ = cancelled.raise()
        reader?.cancelReading()
        writer?.cancelWriting()
        pumps?.finishAll()
    }

    public func export(_ built: StudioComposition, to url: URL, progress: (@Sendable (Double) -> Void)? = nil) async throws -> Result {
        let started = CFAbsoluteTimeGetCurrent()
        try? FileManager.default.removeItem(at: url)
        let asset = built.composition
        let reader = try AVAssetReader(asset: asset)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        self.reader = reader
        self.writer = writer

        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        guard !videoTracks.isEmpty, let videoComposition = built.videoComposition else { throw Failure.cantRead }

        // The compositor draws BGRA; asking for the encoder's own YUV here halves what each queued frame holds.
        let videoOutput = AVAssetReaderVideoCompositionOutput(videoTracks: videoTracks, videoSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: String](),
        ])
        videoOutput.videoComposition = videoComposition
        videoOutput.alwaysCopiesSampleData = false
        guard reader.canAdd(videoOutput) else { throw Failure.cantRead }
        reader.add(videoOutput)

        let size = built.renderSize
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(size.width),
            AVVideoHeightKey: Int(size.height),
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: Self.bitrate(for: size),
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoMaxKeyFrameIntervalDurationKey: 2,
                AVVideoExpectedSourceFrameRateKey: 30,
            ] as [String: Any],
        ])
        videoInput.expectsMediaDataInRealTime = false
        guard writer.canAdd(videoInput) else { throw Failure.cantWrite }
        writer.add(videoInput)

        var audioPair: (AVAssetReaderAudioMixOutput, AVAssetWriterInput)?
        if !audioTracks.isEmpty {
            let audioOutput = AVAssetReaderAudioMixOutput(audioTracks: audioTracks, audioSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ])
            audioOutput.audioMix = built.audioMix
            audioOutput.alwaysCopiesSampleData = false
            let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 160_000,
            ])
            audioInput.expectsMediaDataInRealTime = false
            if reader.canAdd(audioOutput), writer.canAdd(audioInput) {
                reader.add(audioOutput)
                writer.add(audioInput)
                audioPair = (audioOutput, audioInput)
            }
        }

        guard reader.startReading() else { throw reader.error ?? Failure.cantRead }
        guard writer.startWriting() else { throw writer.error ?? Failure.cantWrite }
        writer.startSession(atSourceTime: .zero)

        let total = max(built.duration, 0.001)
        let cancelled = cancelled
        nonisolated(unsafe) let pumpReader = reader
        // A writer that is cancelled or fails stops asking for data, so a pump waiting for room would never hear
        // again. Every pump can be ended from outside: by `cancel()`, or by the other pump failing.
        let pumps = Pumps()
        self.pumps = pumps
        if cancelled.isRaised { pumps.finishAll() }
        @Sendable func pump(_ output: AVAssetReaderOutput, into input: AVAssetWriterInput, label: String, reportsProgress: Bool) async {
            nonisolated(unsafe) let output = output
            nonisolated(unsafe) let input = input
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                guard let handle = pumps.add(continuation) else { return }
                let queue = DispatchQueue(label: "so.cap.mobile.studio.export.\(label)")
                input.requestMediaDataWhenReady(on: queue) {
                    while input.isReadyForMoreMediaData {
                        if handle.isFinished { return }
                        if cancelled.isRaised || pumpReader.status != .reading {
                            pumps.finishAll()
                            return
                        }
                        guard let sample = output.copyNextSampleBuffer() else {
                            input.markAsFinished()
                            handle.finish()
                            return
                        }
                        if reportsProgress {
                            let time = CMSampleBufferGetPresentationTimeStamp(sample).seconds
                            if time.isFinite { progress?(min(1, time / total)) }
                        }
                        if !input.append(sample) {
                            pumps.finishAll()
                            return
                        }
                    }
                }
            }
        }

        // An encoder that fails on its own leaves both inputs waiting with nothing to report it.
        nonisolated(unsafe) let watchedWriter = writer
        let watchdog = Task.detached {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                if watchedWriter.status == .failed || watchedWriter.status == .cancelled {
                    pumps.finishAll()
                    return
                }
            }
        }
        defer { watchdog.cancel() }

        // Each output and input is only ever touched by its own pump.
        nonisolated(unsafe) let videoFeed = (videoOutput as AVAssetReaderOutput, videoInput)
        nonisolated(unsafe) let audioFeed = audioPair.map { ($0.0 as AVAssetReaderOutput, $0.1) }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await pump(videoFeed.0, into: videoFeed.1, label: "video", reportsProgress: true) }
            if let audioFeed {
                group.addTask { await pump(audioFeed.0, into: audioFeed.1, label: "audio", reportsProgress: false) }
            }
        }
        self.pumps = nil
        if writer.status == .failed {
            reader.cancelReading()
            throw writer.error ?? Failure.cantWrite
        }

        if cancelled.isRaised {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: url)
            throw Failure.cancelled
        }
        if reader.status == .failed {
            writer.cancelWriting()
            throw reader.error ?? Failure.cantRead
        }
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? Failure.cantWrite }
        progress?(1)
        let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
        return Result(url: url, duration: built.duration, seconds: CFAbsoluteTimeGetCurrent() - started, bytes: bytes, size: size)
    }
}

final class Flag: Sendable {
    private let value = Atomic<Bool>(false)

    /// True for the call that set it.
    func raise() -> Bool {
        !value.exchange(true, ordering: .acquiringAndReleasing)
    }

    var isRaised: Bool { value.load(ordering: .acquiring) }
}

/// The exporter's feeding loops, each ended exactly once from whichever side gets there first.
final class Pumps: @unchecked Sendable {
    final class Handle: @unchecked Sendable {
        private let done = Flag()
        fileprivate let continuation: CheckedContinuation<Void, Never>

        fileprivate init(_ continuation: CheckedContinuation<Void, Never>) {
            self.continuation = continuation
        }

        var isFinished: Bool { done.isRaised }

        func finish() {
            if done.raise() { continuation.resume() }
        }
    }

    private let lock = NSLock()
    private var handles: [Handle] = []
    private var ended = false

    /// Nil, with the continuation already resumed, once everything has been ended.
    func add(_ continuation: CheckedContinuation<Void, Never>) -> Handle? {
        let handle = Handle(continuation)
        lock.lock()
        let isEnded = ended
        if !isEnded { handles.append(handle) }
        lock.unlock()
        if isEnded {
            handle.finish()
            return nil
        }
        return handle
    }

    func finishAll() {
        lock.lock()
        ended = true
        let all = handles
        lock.unlock()
        for handle in all { handle.finish() }
    }
}
