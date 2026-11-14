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

/// Writes one track of a Studio recording to the phone, at a higher quality than Instant Mode uploads and with a
/// keyframe every second so the editor can land on any frame quickly.
///
/// Picture and sound go to separate files. In one file the writer keeps them interleaved, so when sound stops coming
/// (the microphone muted mid-recording, an audio route change, an interruption) it stops taking pictures a second
/// later and the recording silently freezes. Apart, each runs on its own, and each notes the host clock time of its
/// first sample so they line up again in the editor.
///
/// Append from one serial queue. `clock` is the clock samples are timed on when it isn't the host clock, such as a
/// capture session's.
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
    /// Missing sound longer than this is filled with silence, so what comes after stays where it was said.
    static let audioGapThreshold: Double = 0.1

    public let url: URL
    public let audioURL: URL
    private let settings: Settings
    private let writer: AVAssetWriter
    private var video: AVAssetWriterInput?
    private let audioWriter: AVAssetWriter?
    private let audio: AVAssetWriterInput?
    private let frameDuration: CMTime

    // Append-queue state.
    private var started: CMTime?
    private var lastVideo: CMTime = .invalid
    private var lastSample: CMSampleBuffer?
    private var audioStarted: CMTime?
    private var audioEnd: CMTime = .invalid
    private var finished = false
    private let state = Mutex<State>(State())
    private let clock: CMClock?
    private let onStart: (@Sendable (StudioTrackInfo) -> Void)?

    private struct State {
        var start: CMTime?
        var hostStart: Double?
        var end: CMTime = .zero
        var gaps: [EditRange] = []
        var audioHostStart: Double?
        var audioDuration: Double = 0
        var failed = false
    }

    /// `onStart` is called when the picture starts and again when the sound does, with what's known so far, so a
    /// process that dies mid-recording has still noted where its track begins.
    public init(url: URL, settings: Settings, clock: CMClock? = nil, onStart: (@Sendable (StudioTrackInfo) -> Void)? = nil) throws {
        self.url = url
        audioURL = url.deletingPathExtension().appendingPathExtension("audio.m4a")
        self.settings = settings
        self.clock = clock
        self.onStart = onStart
        try? FileManager.default.removeItem(at: url)
        try? FileManager.default.removeItem(at: audioURL)
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        // A fragment every second: if the app or extension is killed mid-recording, all but the last second plays.
        writer.movieFragmentInterval = CMTime(value: 1, timescale: 1)
        writer.shouldOptimizeForNetworkUse = false
        frameDuration = CMTime(value: 1, timescale: CMTimeScale(settings.fps))
        if settings.audio {
            let audioWriter = try AVAssetWriter(outputURL: audioURL, fileType: .m4a)
            audioWriter.movieFragmentInterval = CMTime(value: 1, timescale: 1)
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 128_000,
            ])
            input.expectsMediaDataInRealTime = true
            guard audioWriter.canAdd(input) else { throw Failure.cantWrite }
            audioWriter.add(input)
            self.audioWriter = audioWriter
            audio = input
        } else {
            audioWriter = nil
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
    var isReadyForAudio: Bool { audioStarted == nil || audio?.isReadyForMoreMediaData ?? true }

    /// Host clock seconds of the first frame, once there is one. Screen and camera tracks are lined up by this.
    public var hostStart: Double? { state.withLock { $0.hostStart } }

    /// Stretches with no frames, in seconds from the first frame.
    public var gaps: [EditRange] { state.withLock { $0.gaps } }

    /// The picture stopped taking frames, for example because the disk filled. What was written before still plays.
    public var failed: Bool { state.withLock { $0.failed } }

    public var info: StudioTrackInfo? {
        state.withLock { value in Self.info(value, file: url.lastPathComponent, audioFile: audioURL.lastPathComponent) }
    }

    private static func info(_ value: State, file: String, audioFile: String) -> StudioTrackInfo? {
        guard let start = value.start, let hostStart = value.hostStart else { return nil }
        var info = StudioTrackInfo(file: file, hostStart: hostStart, duration: max(0, CMTimeSubtract(value.end, start).seconds), gaps: value.gaps.isEmpty ? nil : value.gaps)
        if let audioHostStart = value.audioHostStart {
            info.audio = .init(file: audioFile, hostStart: audioHostStart, duration: value.audioDuration)
        }
        return info
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

    private func reportStart() {
        guard let onStart, let info else { return }
        onStart(info)
    }

    public func appendVideo(_ buffer: CMSampleBuffer) {
        guard !finished else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(buffer)
        guard time.isValid, !lastVideo.isValid || time > lastVideo else { return }
        if started == nil {
            guard let input = makeVideoInput(for: buffer), writer.startWriting() else {
                markFailed()
                return
            }
            video = input
            writer.startSession(atSourceTime: time)
            started = time
            let hostStart = Self.hostSeconds(time, clock: clock)
            state.withLock {
                $0.start = time
                $0.hostStart = hostStart
                $0.end = CMTimeAdd(time, frameDuration)
            }
            reportStart()
        }
        guard writer.status == .writing, let video else {
            if writer.status == .failed { markFailed() }
            return
        }
        // A real-time input that isn't ready drops the frame; the next one carries on at its own time.
        guard video.isReadyForMoreMediaData else { return }
        if video.append(buffer) {
            // Only a camera can be interrupted. A still screen sends no frames and is held by repeats that can be
            // late, and it must keep showing.
            if case .camera = settings.kind, lastVideo.isValid, let started, CMTimeSubtract(time, lastVideo).seconds > Self.gapThreshold {
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
        guard !finished, let audio, let audioWriter else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(buffer)
        let length = CMSampleBufferGetDuration(buffer)
        guard time.isValid else { return }
        if audioStarted == nil {
            guard audioWriter.startWriting() else { return }
            audioWriter.startSession(atSourceTime: time)
            audioStarted = time
            audioEnd = time
            let hostStart = Self.hostSeconds(time, clock: clock)
            state.withLock { $0.audioHostStart = hostStart }
            reportStart()
        }
        guard audioWriter.status == .writing else { return }
        // Overlapping or repeated sound would push everything after it later.
        if audioEnd.isValid, length.isValid, CMTimeAdd(time, length) <= audioEnd { return }
        if audioEnd.isValid, CMTimeSubtract(time, audioEnd).seconds > Self.audioGapThreshold {
            fillSilence(from: audioEnd, to: time, like: buffer)
        }
        guard audio.isReadyForMoreMediaData, audio.append(buffer) else { return }
        audioEnd = length.isValid ? CMTimeAdd(time, length) : time
        if let audioStarted {
            let duration = CMTimeSubtract(audioEnd, audioStarted).seconds
            state.withLock { $0.audioDuration = duration }
        }
    }

    /// Silence in the same format as the sound around it, in one-second pieces.
    private func fillSilence(from start: CMTime, to end: CMTime, like buffer: CMSampleBuffer) {
        guard let audio, let format = CMSampleBufferGetFormatDescription(buffer),
              let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              description.mFormatID == kAudioFormatLinearPCM, description.mSampleRate > 0, description.mBytesPerFrame > 0
        else { return }
        let rate = description.mSampleRate
        let planes = description.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0 ? Int(description.mChannelsPerFrame) : 1
        var cursor = start
        // At most ten minutes: anything longer is a clock jump, not a pause.
        var remaining = min(Int((CMTimeSubtract(end, start).seconds * rate).rounded()), Int(rate * 600))
        while remaining > 0 {
            let frames = min(remaining, Int(rate))
            let bytes = frames * Int(description.mBytesPerFrame) * planes
            var block: CMBlockBuffer?
            guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil, customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr, let block,
                  CMBlockBufferFillDataBytes(with: 0, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes) == noErr
            else { return }
            var silence: CMSampleBuffer?
            guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: frames, presentationTimeStamp: cursor, packetDescriptions: nil, sampleBufferOut: &silence) == noErr, let silence,
                  audio.isReadyForMoreMediaData, audio.append(silence)
            else { return }
            cursor = CMTimeAdd(cursor, CMTime(value: CMTimeValue(frames), timescale: CMTimeScale(rate)))
            audioEnd = cursor
            remaining -= frames
        }
    }

    /// `stop` carries a still screen, which sends no new frames, to the moment recording stopped.
    public func finish(at stop: CMTime? = nil, _ completion: @escaping @Sendable (Result<Double, any Error>) -> Void) {
        guard !finished else {
            // A writer that failed mid-recording keeps its fragments; report what reached the disk.
            finishAudio { completion(.success(self.duration)) }
            return
        }
        finished = true
        guard started != nil, let video, writer.status == .writing else {
            writer.cancelWriting()
            finishAudio { completion(.success(0)) }
            return
        }
        if let stop, let lastSample, lastVideo.isValid, CMTimeSubtract(stop, lastVideo).seconds > frameDuration.seconds * 2,
           let held = SegmentWriter.retime(lastSample, by: CMTimeSubtract(stop, lastVideo)), video.isReadyForMoreMediaData, video.append(held) {
            state.withLock { $0.end = CMTimeAdd(stop, frameDuration) }
        }
        lastSample = nil
        let end = state.withLock { $0.end }
        video.markAsFinished()
        writer.endSession(atSourceTime: end)
        nonisolated(unsafe) let writer = writer
        writer.finishWriting { [self] in
            let status = writer.status
            let error = writer.error
            finishAudio {
                if status == .completed {
                    completion(.success(self.duration))
                } else {
                    completion(.failure(error ?? Failure.cantWrite))
                }
            }
        }
    }

    private func finishAudio(_ done: @escaping @Sendable () -> Void) {
        guard let audioWriter, let audio, audioStarted != nil, audioWriter.status == .writing else {
            if let audioWriter, audioWriter.status == .writing { audioWriter.cancelWriting() }
            done()
            return
        }
        audio.markAsFinished()
        if audioEnd.isValid { audioWriter.endSession(atSourceTime: audioEnd) }
        nonisolated(unsafe) let closing = audioWriter
        closing.finishWriting { done() }
    }

    public func cancel() {
        finished = true
        lastSample = nil
        if writer.status == .writing { writer.cancelWriting() }
        if let audioWriter, audioWriter.status == .writing { audioWriter.cancelWriting() }
        try? FileManager.default.removeItem(at: url)
        try? FileManager.default.removeItem(at: audioURL)
    }
}

/// Written next to a track by whichever process recorded it, so the app can line tracks up afterwards.
public struct StudioTrackInfo: Codable, Sendable, Equatable {
    public struct Audio: Codable, Sendable, Equatable {
        public var file: String
        /// Host clock seconds of the first sound.
        public var hostStart: Double
        /// Zero until finished, as for the picture.
        public var duration: Double

        public init(file: String, hostStart: Double, duration: Double) {
            self.file = file
            self.hostStart = hostStart
            self.duration = duration
        }
    }

    public var file: String
    /// Host clock seconds of the first frame.
    public var hostStart: Double
    /// Zero until the track is finished: a track whose process died is measured from its file instead.
    public var duration: Double
    /// Seconds from the first frame where nothing was recorded, such as a camera iOS paused.
    public var gaps: [EditRange]?
    public var audio: Audio?

    public init(file: String, hostStart: Double, duration: Double, gaps: [EditRange]? = nil, audio: Audio? = nil) {
        self.file = file
        self.hostStart = hostStart
        self.duration = duration
        self.gaps = gaps
        self.audio = audio
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

    /// Lines up whatever was recorded: the earliest picture starts the project at zero, and each track's sound sits
    /// where it was heard relative to its picture.
    public static func align(screen: StudioTrackInfo?, camera: StudioTrackInfo?) -> (screen: StudioProject.Track?, camera: StudioProject.Track?) {
        let usable = [screen, camera].compactMap { $0 }.filter { $0.duration > 0 }
        guard let origin = usable.map(\.hostStart).min() else { return (nil, nil) }
        func track(_ info: StudioTrackInfo?) -> StudioProject.Track? {
            guard let info, info.duration > 0 else { return nil }
            let audio = info.audio.flatMap { $0.duration > 0 ? StudioProject.Track.Audio(file: $0.file, offset: $0.hostStart - info.hostStart, duration: $0.duration) : nil }
            return StudioProject.Track(file: info.file, offset: max(0, info.hostStart - origin), duration: info.duration, gaps: info.gaps, audio: audio)
        }
        return (track(screen), track(camera))
    }
}
