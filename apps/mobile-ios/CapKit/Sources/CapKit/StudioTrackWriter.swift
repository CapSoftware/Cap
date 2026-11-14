@preconcurrency import AVFoundation
import Foundation
import Synchronization

/// What a recorder appends to: `SegmentWriter` uploads as it goes, `StudioTrackWriter` keeps one file on the phone.
public protocol RecordingSink: AnyObject, Sendable {
    func appendVideo(_ buffer: CMSampleBuffer)
    func appendAudio(_ buffer: CMSampleBuffer)
    var duration: Double { get }
    func finish(at stop: CMTime?, _ completion: @escaping @Sendable (Result<Double, any Error>) -> Void)
    func cancel()
}

extension SegmentWriter: RecordingSink {}

/// Writes one track of a Studio recording to a single MP4 on the phone, at a higher quality than Instant Mode
/// uploads and with a keyframe every second so the editor can land on any frame quickly.
///
/// Append from one serial queue. Timestamps stay on the host clock until written, so screen and camera recorded in
/// different processes line up: `hostStart` is the host time of the first frame.
public final class StudioTrackWriter: RecordingSink, @unchecked Sendable {
    public struct Settings: Sendable {
        public enum Kind: Sendable {
            case screen
            case camera
        }

        public var kind: Kind
        public var fps: Int
        public var audio: Bool

        public init(kind: Kind, fps: Int = 30, audio: Bool) {
            self.kind = kind
            self.fps = fps
            self.audio = audio
        }

        /// HEVC at these rates keeps screen text and faces clean through an edit and a second encode, at about
        /// 2.7 GB an hour for a full-resolution iPhone screen and 1.8 GB for the 720p camera.
        public func bitrate(width: Int, height: Int) -> Int {
            switch kind {
            case .screen: min(6_000_000, max(2_500_000, width * height * 2))
            case .camera: min(6_000_000, max(2_000_000, width * height * 4))
            }
        }
    }

    public enum Failure: Error, LocalizedError {
        case cantWrite

        public var errorDescription: String? { "Cap couldn't save the recording. Free up some space and try again." }
    }

    /// A pause longer than this in the frames is a gap (the camera was interrupted), not a slow frame.
    public static let gapThreshold: Double = 0.5

    public let url: URL
    private let settings: Settings
    private let writer: AVAssetWriter
    private var video: AVAssetWriterInput?
    private let audio: AVAssetWriterInput?
    private let frameDuration: CMTime

    // Append-queue state.
    private var started: CMTime?
    private var lastVideo: CMTime = .invalid
    private var lastSample: CMSampleBuffer?
    private var finished = false
    private let state = Mutex<State>(State())
    private let clock: CMClock?
    /// Called once with the host time of the first frame, so a process that dies mid-recording has still noted
    /// where its track starts.
    private let onStart: (@Sendable (Double) -> Void)?

    private struct State {
        var start: CMTime?
        var hostStart: Double?
        var end: CMTime = .zero
        var gaps: [EditRange] = []
        var failed = false
    }

    /// The video's size comes from its first frame: screens and cameras differ from phone to phone. `clock` is the
    /// clock the frames are timed on when it isn't the host clock, such as a capture session's.
    public init(url: URL, settings: Settings, clock: CMClock? = nil, onStart: (@Sendable (Double) -> Void)? = nil) throws {
        self.url = url
        self.settings = settings
        self.clock = clock
        self.onStart = onStart
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        // A fragment every second: if the app or extension is killed mid-recording, all but the last second plays.
        writer.movieFragmentInterval = CMTime(value: 1, timescale: 1)
        writer.shouldOptimizeForNetworkUse = false
        frameDuration = CMTime(value: 1, timescale: CMTimeScale(settings.fps))
        if settings.audio {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 128_000,
            ])
            input.expectsMediaDataInRealTime = true
            if writer.canAdd(input) {
                writer.add(input)
                audio = input
            } else {
                audio = nil
            }
        } else {
            audio = nil
        }
    }

    private func makeVideoInput(for buffer: CMSampleBuffer) -> AVAssetWriterInput? {
        guard let pixels = CMSampleBufferGetImageBuffer(buffer) else { return nil }
        // HEVC wants even sizes.
        let width = CVPixelBufferGetWidth(pixels) & ~1
        let height = CVPixelBufferGetHeight(pixels) & ~1
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            // Every phone iOS 26 runs on encodes HEVC in hardware.
            AVVideoCodecKey: AVVideoCodecType.hevc,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: settings.bitrate(width: width, height: height),
                AVVideoExpectedSourceFrameRateKey: settings.fps,
                AVVideoMaxKeyFrameIntervalDurationKey: 1,
                // No reordered frames: decoding any one frame never needs a later one, so seeks are cheaper.
                AVVideoAllowFrameReorderingKey: false,
            ] as [String: Any],
        ])
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { return nil }
        writer.add(input)
        return input
    }

    /// For feeding a file faster than real time, as tests do.
    var isReadyForVideo: Bool { video?.isReadyForMoreMediaData ?? true }
    var isReadyForAudio: Bool { audio?.isReadyForMoreMediaData ?? true }

    /// Host clock seconds of the first frame, once there is one. Screen and camera tracks are lined up by this.
    public var hostStart: Double? { state.withLock { $0.hostStart } }

    /// Stretches with no frames, in seconds from the first frame.
    public var gaps: [EditRange] { state.withLock { $0.gaps } }

    /// The file stopped taking frames, for example because the disk filled. What was written before still plays.
    public var failed: Bool { state.withLock { $0.failed } }

    public var info: StudioTrackInfo? {
        state.withLock { value in
            guard let start = value.start, let hostStart = value.hostStart else { return nil }
            return StudioTrackInfo(file: url.lastPathComponent, hostStart: hostStart, duration: max(0, CMTimeSubtract(value.end, start).seconds), gaps: value.gaps.isEmpty ? nil : value.gaps)
        }
    }

    static func hostSeconds(_ time: CMTime, clock: CMClock?) -> Double {
        let host = CMClockGetHostTimeClock()
        guard let clock, clock !== host else { return time.seconds }
        return CMSyncConvertTime(time, from: clock, to: host).seconds
    }

    public var duration: Double {
        state.withLock { value in
                guard let start = value.start else { return 0 }
            return max(0, CMTimeSubtract(value.end, start).seconds)
        }
    }

    public func appendVideo(_ buffer: CMSampleBuffer) {
        guard !finished else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(buffer)
        guard time.isValid, !lastVideo.isValid || time > lastVideo else { return }
        if started == nil {
            guard let input = makeVideoInput(for: buffer), writer.startWriting() else {
                finished = true
                return
            }
            video = input
            writer.startSession(atSourceTime: time)
            started = time
            let hostStart = Self.hostSeconds(time, clock: clock)
            state.withLock {
                $0.start = time
                $0.hostStart = hostStart
            }
            onStart?(hostStart)
        }
        guard writer.status == .writing, let video else {
            if writer.status == .failed { markFailed() }
            return
        }
        // A real-time input that isn't ready drops the frame; the next one carries on at its own time.
        guard video.isReadyForMoreMediaData else { return }
        if video.append(buffer) {
            if lastVideo.isValid, let started, CMTimeSubtract(time, lastVideo).seconds > Self.gapThreshold {
                let gap = EditRange(start: CMTimeSubtract(CMTimeAdd(lastVideo, frameDuration), started).seconds, end: CMTimeSubtract(time, started).seconds)
                state.withLock { $0.gaps.append(gap) }
            }
            lastVideo = time
            lastSample = buffer
            let end = CMTimeAdd(time, frameDuration)
            state.withLock { $0.end = end }
        } else if writer.status == .failed {
            markFailed()
        }
    }

    private func markFailed() {
        finished = true
        lastSample = nil
        state.withLock { $0.failed = true }
    }

    public func appendAudio(_ buffer: CMSampleBuffer) {
        guard !finished, let audio, let started, writer.status == .writing, audio.isReadyForMoreMediaData else { return }
        // Audio that began before the first frame would land before the session starts.
        guard CMSampleBufferGetPresentationTimeStamp(buffer) >= started else { return }
        audio.append(buffer)
    }

    /// `stop` carries a still screen, which sends no new frames, to the moment recording stopped.
    public func finish(at stop: CMTime? = nil, _ completion: @escaping @Sendable (Result<Double, any Error>) -> Void) {
        guard !finished else {
            // A writer that failed mid-recording keeps its fragments; report what reached the disk.
            completion(.success(duration))
            return
        }
        finished = true
        guard started != nil, let video, writer.status == .writing else {
            writer.cancelWriting()
            completion(.success(0))
            return
        }
        if let stop, let lastSample, lastVideo.isValid, CMTimeSubtract(stop, lastVideo).seconds > frameDuration.seconds * 2,
           let held = SegmentWriter.retime(lastSample, by: CMTimeSubtract(stop, lastVideo)), video.isReadyForMoreMediaData, video.append(held) {
            state.withLock { $0.end = CMTimeAdd(stop, frameDuration) }
        }
        lastSample = nil
        let end = state.withLock { $0.end }
        video.markAsFinished()
        audio?.markAsFinished()
        writer.endSession(atSourceTime: end)
        nonisolated(unsafe) let writer = writer
        writer.finishWriting { [self] in
            if writer.status == .completed {
                completion(.success(duration))
            } else {
                completion(.failure(writer.error ?? Failure.cantWrite))
            }
        }
    }

    public func cancel() {
        finished = true
        lastSample = nil
        if writer.status == .writing { writer.cancelWriting() }
        try? FileManager.default.removeItem(at: url)
    }
}

/// Written next to a track by whichever process recorded it, so the app can line tracks up afterwards.
public struct StudioTrackInfo: Codable, Sendable, Equatable {
    public var file: String
    /// Host clock seconds of the first frame.
    public var hostStart: Double
    /// Zero until the track is finished: a track whose process died is measured from its file instead.
    public var duration: Double
    /// Seconds from the first frame where nothing was recorded, such as a camera iOS paused.
    public var gaps: [EditRange]?

    public init(file: String, hostStart: Double, duration: Double, gaps: [EditRange]? = nil) {
        self.file = file
        self.hostStart = hostStart
        self.duration = duration
        self.gaps = gaps
    }

    public static func url(for track: String, in directory: URL) -> URL {
        directory.appending(path: "\(track).json")
    }

    public func save(as track: String, in directory: URL) throws {
        try JSONEncoder().encode(self).write(to: Self.url(for: track, in: directory), options: .atomic)
    }

    public static func load(_ track: String, in directory: URL) -> StudioTrackInfo? {
        guard let data = try? Data(contentsOf: url(for: track, in: directory)) else { return nil }
        return try? JSONDecoder().decode(StudioTrackInfo.self, from: data)
    }

    /// Lines up whatever was recorded: the earliest track starts the project at zero.
    public static func align(screen: StudioTrackInfo?, camera: StudioTrackInfo?) -> (screen: StudioProject.Track?, camera: StudioProject.Track?) {
        let usable = [screen, camera].compactMap { $0 }.filter { $0.duration > 0 }
        guard let origin = usable.map(\.hostStart).min() else { return (nil, nil) }
        func track(_ info: StudioTrackInfo?) -> StudioProject.Track? {
            guard let info, info.duration > 0 else { return nil }
            return StudioProject.Track(file: info.file, offset: max(0, info.hostStart - origin), duration: info.duration, gaps: info.gaps)
        }
        return (track(screen), track(camera))
    }
}
