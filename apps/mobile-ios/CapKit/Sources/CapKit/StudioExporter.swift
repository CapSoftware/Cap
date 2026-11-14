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

    public init() {}

    public func cancel() {
        _ = cancelled.raise()
        reader?.cancelReading()
        writer?.cancelWriting()
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
        nonisolated(unsafe) let pumpWriter = writer
        nonisolated(unsafe) let pumpReader = reader
        func pump(_ output: AVAssetReaderOutput, into input: AVAssetWriterInput, label: String, reportsProgress: Bool) async {
            nonisolated(unsafe) let output = output
            nonisolated(unsafe) let input = input
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let queue = DispatchQueue(label: "so.cap.mobile.studio.export.\(label)")
                let done = Flag()
                input.requestMediaDataWhenReady(on: queue) {
                    while input.isReadyForMoreMediaData {
                        if cancelled.isRaised || pumpReader.status != .reading {
                            input.markAsFinished()
                            if done.raise() { continuation.resume() }
                            return
                        }
                        guard let sample = output.copyNextSampleBuffer() else {
                            input.markAsFinished()
                            if done.raise() { continuation.resume() }
                            return
                        }
                        if reportsProgress {
                            let time = CMSampleBufferGetPresentationTimeStamp(sample).seconds
                            if time.isFinite { progress?(min(1, time / total)) }
                        }
                        if !input.append(sample) {
                            if done.raise() { continuation.resume() }
                            return
                        }
                    }
                }
            }
            _ = pumpWriter
        }

        await withTaskGroup(of: Void.self) { group in
            group.addTask { await pump(videoOutput, into: videoInput, label: "video", reportsProgress: true) }
            if let audioPair {
                group.addTask { await pump(audioPair.0, into: audioPair.1, label: "audio", reportsProgress: false) }
            }
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

/// Set once from any thread.
final class Flag: Sendable {
    private let value = Atomic<Bool>(false)

    /// True for the call that set it.
    func raise() -> Bool {
        !value.exchange(true, ordering: .acquiringAndReleasing)
    }

    var isRaised: Bool { value.load(ordering: .acquiring) }
}
