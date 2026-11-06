@preconcurrency import AVFoundation
import Foundation
import Synchronization

/// Encodes video and audio into separate fragmented MP4 tracks, cut every couple of seconds, and
/// writes each piece to disk the moment the encoder emits it so it can upload while recording continues.
///
/// Append from one serial queue. Timestamps are shifted so the recording starts at zero, which lets
/// the writers start before the first frame arrives.
public final class SegmentWriter: NSObject, AVAssetWriterDelegate, @unchecked Sendable {
    public struct VideoFormat: Sendable {
        public let width: Int
        public let height: Int
        public let fps: Int
        public let bitrate: Int

        public init(width: Int, height: Int, fps: Int, bitrate: Int) {
            self.width = width
            self.height = height
            self.fps = fps
            self.bitrate = bitrate
        }
    }

    public enum Failure: Error, LocalizedError {
        case cantEncode
        case writeFailed

        public var errorDescription: String? {
            switch self {
            case .cantEncode: "The camera's video couldn't be encoded."
            case .writeFailed: "Cap couldn't save the recording. Free up some space and try again."
            }
        }
    }

    private let directory: URL
    private let videoWriter: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    private let audioWriter: AVAssetWriter?
    private let audioInput: AVAssetWriterInput?
    private let onSegment: @Sendable (RecordedSegment) -> Void
    private let onFailure: @Sendable (any Error) -> Void
    private let segmentInterval: Double

    // Append-queue state.
    private var offset: CMTime?
    private var lastVideoEnd: CMTime = .zero
    private var lastVideoTime: CMTime = .invalid
    private let frameDuration: CMTime
    /// The last frame written, held so a still screen can be carried to the moment recording stops.
    private var lastVideoSample: CMSampleBuffer?
    /// Where the audio written so far ends, on the recording's timeline.
    private var audioEnd: CMTime = .zero
    /// Brings each audio source to `audioFormat`.
    private var resampler: AVAudioConverter?
    private let encoder: AudioEncoder?
    /// Encoded audio waiting for the writer, which can be briefly busy.
    private var pendingAudio: [CMSampleBuffer] = []
    /// Audio can break on its own, for example when headphones change the microphone mid-recording.
    /// The video carries on, and the audio recorded until then is kept.
    private let audioBroken = Atomic<Bool>(false)
    private var finishing = false
    /// Set from the append queue or a writer's delegate queue.
    private let failed = Atomic<Bool>(false)

    // Each writer calls its delegate serially, so each track's counter has a single writer.
    private var videoIndex = 0
    private var audioIndex = 0

    public init(
        directory: URL,
        video: VideoFormat,
        audio: Bool,
        segmentInterval: Double = RecordingLimits.segmentDuration,
        onSegment: @escaping @Sendable (RecordedSegment) -> Void,
        onFailure: @escaping @Sendable (any Error) -> Void
    ) throws {
        self.directory = directory
        self.onSegment = onSegment
        self.onFailure = onFailure
        self.segmentInterval = segmentInterval
        frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(1, video.fps)))

        videoWriter = AVAssetWriter(contentType: .mpeg4Movie)
        videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: video.width,
            AVVideoHeightKey: video.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: video.bitrate,
                AVVideoExpectedSourceFrameRateKey: video.fps,
                // A keyframe at every cut, so each segment stands alone.
                AVVideoMaxKeyFrameIntervalDurationKey: segmentInterval,
                AVVideoAllowFrameReorderingKey: false,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
            ] as [String: Any],
        ])
        videoInput.expectsMediaDataInRealTime = true

        if audio {
            guard let encoder = AudioEncoder(input: Self.audioFormat, bitRate: 96_000) else { throw Failure.cantEncode }
            // Already encoded, so the writer only packages it.
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: encoder.formatDescription)
            input.expectsMediaDataInRealTime = true
            self.encoder = encoder
            audioWriter = AVAssetWriter(contentType: .mpeg4Movie)
            audioInput = input
        } else {
            encoder = nil
            audioWriter = nil
            audioInput = nil
        }
        super.init()

        var pairs = [(videoWriter, videoInput)]
        if let audioWriter, let audioInput { pairs.append((audioWriter, audioInput)) }
        for (writer, input) in pairs {
            guard writer.canAdd(input) else { throw Failure.cantEncode }
            writer.add(input)
            writer.outputFileTypeProfile = .mpeg4CMAFCompliant
            writer.preferredOutputSegmentInterval = CMTime(seconds: segmentInterval, preferredTimescale: 600)
            writer.initialSegmentStartTime = .zero
            writer.delegate = self
            guard writer.startWriting() else { throw writer.error ?? Failure.cantEncode }
            writer.startSession(atSourceTime: .zero)
        }
    }

    /// Seconds of video written so far.
    public var duration: Double { lastVideoEnd.seconds }

    /// Audio gaps and overlaps smaller than this are timing jitter, not missing sound.
    private static let audioJitter = CMTime(value: 1, timescale: 20)
    /// How far audio may trail the video before the missing stretch is filled with silence.
    private static let audioLag = CMTime(value: 3, timescale: 2)

    /// Every source (the camera's microphone, the phone's mic or its app sound) is converted to this,
    /// so a source can change mid-recording without breaking the track.
    static let audioFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!

    public func appendVideo(_ buffer: CMSampleBuffer) {
        guard !finishing, !failed.load(ordering: .relaxed) else { return }
        let presentation = CMSampleBufferGetPresentationTimeStamp(buffer)
        guard presentation.isNumeric else { return }
        if offset == nil { offset = presentation }
        // A sample that doesn't move time forward would fail the whole writer; skip it instead.
        guard !lastVideoTime.isValid || presentation > lastVideoTime else { return }
        guard videoInput.isReadyForMoreMediaData, let shifted = shift(buffer) else { return }
        lastVideoTime = presentation
        guard videoInput.append(shifted) else {
            fail(videoWriter.error ?? Failure.cantEncode)
            return
        }
        lastVideoSample = shifted
        let duration = CMSampleBufferGetDuration(buffer)
        lastVideoEnd = CMTimeAdd(CMSampleBufferGetPresentationTimeStamp(shifted), duration.isNumeric && duration > .zero ? duration : frameDuration)
        // A source that has gone quiet (or never started) still needs its stretch of the timeline.
        if audioInput != nil, CMTimeSubtract(lastVideoEnd, audioEnd) > Self.audioLag {
            appendSilence(until: CMTimeSubtract(lastVideoEnd, CMTime(value: 1, timescale: 1)), waiting: false)
        }
    }

    /// Takes any linear PCM. Audio before the first frame is dropped so both tracks start together,
    /// and gaps are filled with silence so the audio always covers the video.
    public func appendAudio(_ buffer: CMSampleBuffer) {
        guard !finishing, !failed.load(ordering: .relaxed), !audioBroken.load(ordering: .relaxed), audioInput != nil, offset != nil,
              let shifted = shift(buffer)
        else { return }
        let start = CMSampleBufferGetPresentationTimeStamp(shifted)
        guard start.isNumeric, start >= .zero, let converted = convert(buffer) else { return }
        if start > CMTimeAdd(audioEnd, Self.audioJitter) {
            appendSilence(until: start, waiting: false)
        } else if start < CMTimeSubtract(audioEnd, Self.audioJitter) {
            // Already covered, by silence that filled a stall or by an overlapping buffer.
            return
        }
        // Placed straight after what came before, so jitter never opens a gap.
        appendConverted(converted, waiting: false)
    }

    /// Flushes the last segments to disk and reports the recorded duration.
    /// - Parameter stop: when recording stopped, on the samples' clock. A still screen sends no new
    ///   frames, so the last one is held until then.
    public func finish(at stop: CMTime? = nil, _ completion: @escaping @Sendable (Result<Double, any Error>) -> Void) {
        guard !finishing else { return }
        guard !failed.load(ordering: .relaxed) else {
            finishing = true
            completion(.failure(Failure.cantEncode))
            return
        }
        let audioUsable = !audioBroken.load(ordering: .relaxed)
        if !audioUsable { audioWriter?.cancelWriting() }
        let writers = [videoWriter] + (audioUsable ? audioWriter.map { [$0] } ?? [] : [])
        guard let offset else {
            // Stopped before a single frame arrived.
            finishing = true
            writers.forEach { $0.cancelWriting() }
            completion(.success(0))
            return
        }
        var end = lastVideoEnd
        if let stop, stop.isNumeric {
            let stopped = CMTimeSubtract(stop, offset)
            // Bounded, in case the clock given isn't the samples' clock.
            if stopped > end, CMTimeSubtract(stopped, end) < CMTime(value: 5, timescale: 1) { end = stopped }
        }
        if let last = lastVideoSample, CMTimeSubtract(end, lastVideoEnd) > frameDuration {
            let at = CMTimeSubtract(end, frameDuration)
            if let held = Self.retime(last, to: at, duration: frameDuration), Self.waitUntilReady(videoInput), videoInput.append(held) {
                lastVideoEnd = end
            }
        }
        end = lastVideoEnd
        if audioUsable, let encoder {
            appendSilence(until: end, waiting: true)
            // Push the encoder's delay through with silence so the last of the sound comes out,
            // keeping only packets that start before the end.
            encoder.cutoff = end
            appendSilence(until: CMTimeAdd(end, encoder.delay), waiting: true)
            flushAudio(waiting: true)
        }
        finishing = true
        lastVideoSample = nil
        let duration = end.seconds
        videoInput.markAsFinished()
        videoWriter.endSession(atSourceTime: end)
        if audioUsable {
            audioInput?.markAsFinished()
        }
        let group = DispatchGroup()
        for writer in writers {
            group.enter()
            writer.finishWriting { group.leave() }
        }
        // The writers hold their delegate weakly, and the last segments arrive while they finish;
        // keep this object alive until then or the tail of the recording is lost.
        group.notify(queue: .global(qos: .userInitiated)) { [self] in
            withExtendedLifetime(self) {}
            if let broken = writers.first(where: { $0.status != .completed }) {
                completion(.failure(broken.error ?? Failure.cantEncode))
            } else {
                completion(.success(duration))
            }
        }
    }

    // MARK: Audio

    /// Converts to `audioFormat`. The converter is rebuilt when the source format changes,
    /// for example when headphones connect and the microphone changes.
    private func convert(_ buffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let description = CMSampleBufferGetFormatDescription(buffer),
              let source = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
              source.mFormatID == kAudioFormatLinearPCM, source.mSampleRate > 0
        else { return nil }
        let frames = CMSampleBufferGetNumSamples(buffer)
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        guard frames > 0, let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return nil }
        input.frameLength = AVAudioFrameCount(frames)
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(buffer, at: 0, frameCount: Int32(frames), into: input.mutableAudioBufferList) == noErr else { return nil }
        if resampler?.inputFormat != format {
            resampler = AVAudioConverter(from: format, to: Self.audioFormat)
            // No priming delay: output lines up with the input's timestamps.
            resampler?.primeMethod = .none
        }
        guard let converter = resampler else { return nil }
        let capacity = AVAudioFrameCount((Double(frames) * Self.audioFormat.sampleRate / source.mSampleRate).rounded(.up)) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: Self.audioFormat, frameCapacity: capacity) else { return nil }
        nonisolated(unsafe) var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return input
        }
        guard status != .error, output.frameLength > 0 else { return nil }
        return output
    }

    /// Encodes converted audio, placed at the end of what's already written.
    @discardableResult
    private func appendConverted(_ pcm: AVAudioPCMBuffer, waiting: Bool) -> Bool {
        guard let encoder else { return false }
        guard let packets = encoder.encode(pcm) else {
            audioBroken.store(true, ordering: .relaxed)
            return false
        }
        pendingAudio += packets
        audioEnd = CMTimeAdd(audioEnd, CMTime(value: CMTimeValue(pcm.frameLength), timescale: CMTimeScale(Self.audioFormat.sampleRate)))
        flushAudio(waiting: waiting)
        return true
    }

    private func flushAudio(waiting: Bool) {
        guard let audioInput else { return }
        var written = 0
        defer { pendingAudio.removeFirst(written) }
        for packet in pendingAudio {
            guard !audioBroken.load(ordering: .relaxed), waiting ? Self.waitUntilReady(audioInput) : audioInput.isReadyForMoreMediaData else { return }
            guard audioInput.append(packet) else {
                audioBroken.store(true, ordering: .relaxed)
                return
            }
            written += 1
        }
    }

    /// Fills the audio with silence up to `time`, a second at a time.
    private func appendSilence(until time: CMTime, waiting: Bool) {
        let rate = Self.audioFormat.sampleRate
        while !audioBroken.load(ordering: .relaxed) {
            let missing = Int((CMTimeSubtract(time, audioEnd).seconds * rate).rounded())
            guard missing > 0, let silence = AVAudioPCMBuffer(pcmFormat: Self.audioFormat, frameCapacity: AVAudioFrameCount(min(missing, Int(rate)))) else { return }
            silence.frameLength = silence.frameCapacity
            for channel in UnsafeMutableAudioBufferListPointer(silence.mutableAudioBufferList) {
                if let data = channel.mData { memset(data, 0, Int(channel.mDataByteSize)) }
            }
            guard appendConverted(silence, waiting: waiting) else { return }
        }
    }

    /// Real-time inputs can be briefly busy; at the end of a recording it's worth a short wait.
    private static func waitUntilReady(_ input: AVAssetWriterInput) -> Bool {
        for _ in 0..<200 {
            if input.isReadyForMoreMediaData { return true }
            usleep(5_000)
        }
        return input.isReadyForMoreMediaData
    }

    public func cancel() {
        finishing = true
        videoWriter.cancelWriting()
        audioWriter?.cancelWriting()
    }

    private func shift(_ buffer: CMSampleBuffer) -> CMSampleBuffer? {
        guard let offset else { return nil }
        return Self.retime(buffer, by: CMTimeMultiply(offset, multiplier: -1))
    }

    /// Moves every sample's timestamps by `delta`. Copies the timing only; the pixel or audio data is shared.
    public static func retime(_ buffer: CMSampleBuffer, by delta: CMTime) -> CMSampleBuffer? {
        var count: CMItemCount = 0
        CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
        guard count > 0 else { return nil }
        var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
        CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count)
        for index in timing.indices {
            timing[index].presentationTimeStamp = CMTimeAdd(timing[index].presentationTimeStamp, delta)
            if timing[index].decodeTimeStamp.isValid {
                timing[index].decodeTimeStamp = CMTimeAdd(timing[index].decodeTimeStamp, delta)
            }
        }
        var shifted: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: buffer, sampleTimingEntryCount: count, sampleTimingArray: &timing, sampleBufferOut: &shifted)
        return shifted
    }

    /// A copy of a single frame shown at `time` for `duration`.
    static func retime(_ buffer: CMSampleBuffer, to time: CMTime, duration: CMTime) -> CMSampleBuffer? {
        var timing = CMSampleTimingInfo(duration: duration, presentationTimeStamp: time, decodeTimeStamp: .invalid)
        var copy: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: buffer, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleBufferOut: &copy)
        return copy
    }

    private func fail(_ error: any Error) {
        guard !failed.exchange(true, ordering: .relaxed) else { return }
        onFailure(error)
    }

    // MARK: AVAssetWriterDelegate

    public func assetWriter(_ writer: AVAssetWriter, didOutputSegmentData segmentData: Data, segmentType: AVAssetSegmentType, segmentReport: AVAssetSegmentReport?) {
        let track: RecordingTrack = writer === videoWriter ? .video : .audio
        let index: Int
        if segmentType == .initialization {
            index = 0
        } else if track == .video {
            videoIndex += 1
            index = videoIndex
        } else {
            audioIndex += 1
            index = audioIndex
        }
        let reported = segmentReport?.trackReports.first?.duration.seconds ?? 0
        let duration = index == 0 ? 0 : (reported.isFinite && reported > 0 ? reported : segmentInterval)
        let segment = RecordedSegment(track: track, index: index, duration: duration, bytes: Int64(segmentData.count))
        do {
            try segmentData.write(to: directory.appending(path: segment.fileName), options: [.completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            fail(Failure.writeFailed)
            return
        }
        onSegment(segment)
    }
}

/// Encodes the recording's audio to AAC so the encoder's start-up delay can be left out.
///
/// AAC encoders begin with about two packets of lead-in. Kept, they're marked discarded when the
/// recording is processed but not in the uploaded source, and processing rejects that difference;
/// left out, the sound lands about a millisecond late, which nobody can hear.
final class AudioEncoder {
    let formatDescription: CMAudioFormatDescription
    /// Packets starting at or after this are dropped; set when the recording ends.
    var cutoff: CMTime?
    /// How much input it takes to bring every earlier sample out of the encoder.
    var delay: CMTime { CMTime(value: CMTimeValue((primingPackets + 1) * Self.framesPerPacket), timescale: timescale) }

    private static let framesPerPacket = 1024
    private let converter: AVAudioConverter
    private let format: AVAudioFormat
    private let timescale: CMTimeScale
    private let primingPackets: Int
    private var dropped = 0
    private var packets: Int64 = 0

    init?(input: AVAudioFormat, bitRate: Int) {
        var description = AudioStreamBasicDescription(
            mSampleRate: input.sampleRate, mFormatID: kAudioFormatMPEG4AAC, mFormatFlags: 0,
            mBytesPerPacket: 0, mFramesPerPacket: UInt32(Self.framesPerPacket), mBytesPerFrame: 0,
            mChannelsPerFrame: input.channelCount, mBitsPerChannel: 0, mReserved: 0
        )
        guard let format = AVAudioFormat(streamDescription: &description),
              let converter = AVAudioConverter(from: input, to: format),
              let cookie = converter.magicCookie
        else { return nil }
        converter.bitRate = bitRate
        let leading = Int(converter.primeInfo.leadingFrames)
        primingPackets = (leading > 0 ? leading : 2112) / Self.framesPerPacket
        var formatDescription: CMAudioFormatDescription?
        let status = cookie.withUnsafeBytes { bytes in
            CMAudioFormatDescriptionCreate(
                allocator: kCFAllocatorDefault, asbd: format.streamDescription, layoutSize: 0, layout: nil,
                magicCookieSize: bytes.count, magicCookie: bytes.baseAddress, extensions: nil,
                formatDescriptionOut: &formatDescription
            )
        }
        guard status == noErr, let formatDescription else { return nil }
        self.converter = converter
        self.format = format
        self.formatDescription = formatDescription
        timescale = CMTimeScale(input.sampleRate)
    }

    /// Encodes `pcm` and returns the packets now ready, timed from zero. Nil if encoding failed.
    func encode(_ pcm: AVAudioPCMBuffer) -> [CMSampleBuffer]? {
        var ready: [CMSampleBuffer] = []
        nonisolated(unsafe) var supplied = false
        while true {
            let output = AVAudioCompressedBuffer(format: format, packetCapacity: 16, maximumPacketSize: max(converter.maximumOutputPacketSize, 1536))
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, inputStatus in
                if supplied {
                    inputStatus.pointee = .noDataNow
                    return nil
                }
                supplied = true
                inputStatus.pointee = .haveData
                return pcm
            }
            if status == .error { return nil }
            for index in 0..<Int(output.packetCount) {
                guard dropped >= primingPackets else {
                    dropped += 1
                    continue
                }
                do {
                    if let packet = try packet(index, of: output) { ready.append(packet) }
                } catch {
                    return nil
                }
            }
            guard status == .haveData else { return ready }
        }
    }

    /// The packet as a sample buffer, or nil when it falls after the cutoff.
    private func packet(_ index: Int, of output: AVAudioCompressedBuffer) throws(SegmentWriter.Failure) -> CMSampleBuffer? {
        guard let descriptions = output.packetDescriptions else { throw .cantEncode }
        let start = CMTime(value: packets * Int64(Self.framesPerPacket), timescale: timescale)
        packets += 1
        if let cutoff, start >= cutoff { return nil }
        let description = descriptions[index]
        let size = Int(description.mDataByteSize)
        var block: CMBlockBuffer?
        guard size > 0,
              CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: size, blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: size, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr,
              let block,
              CMBlockBufferReplaceDataBytes(with: output.data.advanced(by: Int(description.mStartOffset)), blockBuffer: block, offsetIntoDestination: 0, dataLength: size) == noErr
        else { throw .cantEncode }
        var packetDescription = AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(size))
        var sample: CMSampleBuffer?
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: formatDescription, sampleCount: 1, presentationTimeStamp: start, packetDescriptions: &packetDescription, sampleBufferOut: &sample) == noErr,
              let sample
        else { throw .cantEncode }
        return sample
    }
}
