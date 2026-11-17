import CoreMedia
import CoreVideo
import Foundation
import Synchronization
import Testing
@testable import CapKit

@Suite struct RecordingTests {
    private func job(phase: RecordingJob.Phase = .recording, hasAudio: Bool = true, segments: [RecordedSegment] = []) -> RecordingJob {
        var job = RecordingJob(userId: testCredentials.userId, title: "Cap Recording", format: .init(width: 1080, height: 1920, fps: 30), organizationId: nil, folderId: nil, hasAudio: hasAudio)
        job.phase = phase
        job.segments = segments
        return job
    }

    private func segment(_ track: RecordingTrack, _ index: Int, state: RecordedSegment.State = .pending, duration: Double = 2) -> RecordedSegment {
        var segment = RecordedSegment(track: track, index: index, duration: index == 0 ? 0 : duration, bytes: 100)
        segment.state = state
        return segment
    }

    @Test func subpathsMatchTheServerPattern() throws {
        let pattern = try Regex("^segments/(?:video|audio)/(?:init\\.mp4|segment_[0-9]{3,6}\\.m4s)$")
        for (track, index) in [(RecordingTrack.video, 0), (.audio, 1), (.video, 42), (.audio, 999), (.video, 1000), (.video, 18_000)] {
            #expect(RecordedSegment.subpath(track: track, index: index).wholeMatch(of: pattern) != nil)
        }
        #expect(RecordedSegment.subpath(track: .video, index: 7) == "segments/video/segment_007.m4s")
        #expect(RecordedSegment(track: .audio, index: 0, duration: 0, bytes: 1).fileName == "audio_init.mp4")
    }

    @Test func plannerPrefetchesTheFirstSegmentsOfEachTrack() {
        let batch = RecordingTargetPlanner.subpathsToRequest(for: job(), known: [])
        #expect(batch.count == 2 * RecordingTargetPlanner.lookahead)
        #expect(batch.contains("segments/video/init.mp4"))
        #expect(batch.contains("segments/audio/init.mp4"))
        #expect(batch.contains("segments/audio/segment_004.m4s"))
    }

    @Test func plannerWaitsWhileThereIsRunwayAndRefillsWhenLow() {
        let known = Set(RecordingTargetPlanner.subpathsToRequest(for: job(), known: []))
        let early = job(segments: [segment(.video, 0, state: .uploaded), segment(.audio, 0, state: .uploaded), segment(.video, 1), segment(.audio, 1)])
        #expect(RecordingTargetPlanner.subpathsToRequest(for: early, known: known).isEmpty)

        // Down to fewer than `runway` known links ahead on each track.
        let filled = RecordingTargetPlanner.lookahead - RecordingTargetPlanner.runway + 1
        let later = job(segments: (0..<filled).flatMap { [segment(.video, $0, state: .uploaded), segment(.audio, $0, state: .uploaded)] })
        let refill = RecordingTargetPlanner.subpathsToRequest(for: later, known: known)
        #expect(refill.first == RecordedSegment.subpath(track: .video, index: RecordingTargetPlanner.lookahead))
        #expect(refill.contains(RecordedSegment.subpath(track: .audio, index: filled + RecordingTargetPlanner.lookahead - 1)))
        #expect(!refill.contains { known.contains($0) })
    }

    @Test func plannerOnlyAsksForWhatIsLeftOnceStopped() {
        let stopped = job(phase: .uploading, segments: [segment(.video, 0, state: .uploaded), segment(.video, 1), segment(.audio, 0)])
        #expect(Set(RecordingTargetPlanner.subpathsToRequest(for: stopped, known: [])) == ["segments/video/segment_001.m4s", "segments/audio/init.mp4"])
        #expect(RecordingTargetPlanner.subpathsToRequest(for: stopped, known: ["segments/video/segment_001.m4s", "segments/audio/init.mp4"]).isEmpty)
    }

    @Test func plannerNeverExceedsTheServerBatchLimit() {
        let backlog = job(phase: .uploading, segments: (1...60).map { segment(.video, $0) })
        #expect(RecordingTargetPlanner.subpathsToRequest(for: backlog, known: []).count == RecordingTargetPlanner.maxBatch)
    }

    @Test func plannerSkipsAudioWithoutAMicrophone() {
        #expect(!RecordingTargetPlanner.subpathsToRequest(for: job(hasAudio: false), known: []).contains { $0.contains("audio") })
    }

    @Test func completionListsContiguousSegments() throws {
        var recorded = job(phase: .uploading, segments: [segment(.video, 0), segment(.video, 2, duration: 0.4), segment(.video, 1), segment(.audio, 0), segment(.audio, 1, duration: 0)])
        recorded.durationSeconds = 2.4
        let completion = try recorded.completion()
        #expect(completion.videoSegments.map(\.index) == [1, 2])
        #expect(completion.videoSegments.last?.duration == 0.4)
        #expect(completion.audioSegments.first?.duration == 0.001, "zero-length tails are clamped so the server accepts them")
        #expect(completion.totalBytes == 500)
    }

    @Test func completionRejectsGapsAndMissingInits() {
        var gap = job(phase: .uploading, segments: [segment(.video, 0), segment(.video, 1), segment(.video, 3)])
        gap.durationSeconds = 6
        #expect(throws: RecordingError.missingSegments) { try gap.completion() }

        var noInit = job(phase: .uploading, segments: [segment(.video, 1)])
        noInit.durationSeconds = 2
        #expect(throws: RecordingError.missingSegments) { try noInit.completion() }

        var empty = job(phase: .uploading, segments: [segment(.video, 0)])
        empty.durationSeconds = 1
        #expect(throws: RecordingError.empty) { try empty.completion() }
    }
}

/// Answers storage PUTs for the uploader's session.
final class StorageStub: URLProtocol {
    static let log = Mutex<[String]>([])
    static let failFirst = Mutex<Set<String>>([])

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host() == "storage.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path() ?? ""
        let shouldFail = Self.failFirst.withLock { $0.remove(path) != nil }
        Self.log.withLock { $0.append("\(request.httpMethod ?? "") \(path)\(shouldFail ? " 403" : "")") }
        let response = HTTPURLResponse(url: request.url!, statusCode: shouldFail ? 403 : 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class CompletionLog: Sendable {
    private let state = Mutex<[Data]>([])
    func append(_ data: Data) { state.withLock { $0.append(data) } }
    var first: Data? { state.withLock { $0.first } }
    var isEmpty: Bool { state.withLock { $0.isEmpty } }
    var count: Int { state.withLock { $0.count } }
}

@Suite(.serialized) struct RecordingUploadTests {
    private func makeRoot() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "rec \(UUID().uuidString)/Application Support/CapRecordings", directoryHint: .isDirectory)
    }

    private func makeUploads(root: URL, completed: CompletionLog, adoptsHandOffs: Bool = false) -> (RecordingUploads, RecordingTransport) {
        let (api, transport) = makeAPI { request in
            let path = request.url?.path() ?? ""
            if path == "/api/mobile/recordings" {
                return (200, Data(#"{"id":"cap_rec","shareUrl":"https://cap.so/s/cap_rec"}"#.utf8))
            }
            if path.hasSuffix("/segments/targets") {
                let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: [String]]
                var uploads: [String: Any] = [:]
                for subpath in body?["subpaths"] ?? [] {
                    uploads[subpath] = ["type": "put", "url": "https://storage.test/\(subpath)", "headers": ["Content-Type": "video/mp4"]]
                }
                return (200, try JSONSerialization.data(withJSONObject: ["uploads": uploads]))
            }
            if path.hasSuffix("/complete") {
                completed.append(request.httpBody ?? Data())
                return (200, Data(#"{"success":true}"#.utf8))
            }
            return (404, Data())
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StorageStub.self]
        let uploads = RecordingUploads(root: root, api: api, engine: UploadEngine(environment: .production), currentUserId: { testCredentials.userId }, configuration: configuration, adoptsHandOffs: adoptsHandOffs)
        return (uploads, transport)
    }

    private func write(_ segment: RecordedSegment, in uploads: RecordingUploads, job: String) throws {
        try Data(repeating: 7, count: Int(segment.bytes)).write(to: uploads.directory(for: job).appending(path: segment.fileName))
        uploads.add(segment, to: job)
    }

    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() {
            try? await Task.sleep(for: .milliseconds(25))
        }
    }

    @Test func uploadsWhileRecordingAndCompletesOnStop() async throws {
        let root = makeRoot()
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent().deletingLastPathComponent()) }
        StorageStub.log.withLock { $0.removeAll() }
        StorageStub.failFirst.withLock { $0 = ["/segments/video/segment_002.m4s"] }
        let completed = CompletionLog()
        let (uploads, transport) = makeUploads(root: root, completed: completed)
        let recording = RecordingJob(userId: testCredentials.userId, title: "Cap Recording", format: .init(width: 1080, height: 1920, fps: 30), organizationId: nil, folderId: nil, hasAudio: true)
        RecordingUploads.markActive(recording.id, true)
        uploads.begin(recording)

        for index in 0...3 {
            try write(RecordedSegment(track: .video, index: index, duration: index == 0 ? 0 : 2, bytes: 64), in: uploads, job: recording.id)
            try write(RecordedSegment(track: .audio, index: index, duration: index == 0 ? 0 : 2, bytes: 16), in: uploads, job: recording.id)
        }
        await waitFor { StorageStub.log.withLock { $0.count } >= 7 }
        #expect(uploads.job(recording.id)?.phase == .recording)
        #expect(completed.isEmpty, "nothing completes while still recording")

        uploads.finish(recording.id, durationSeconds: 6)
        RecordingUploads.markActive(recording.id, false)
        await waitFor { !completed.isEmpty }

        let body = try #require(completed.first)
        let completion = try JSONDecoder().decode(RecordingCompletion.self, from: body)
        #expect(completion.videoSegments.map(\.index) == [1, 2, 3])
        #expect(completion.audioSegments.map(\.index) == [1, 2, 3])
        #expect(completion.totalBytes == 4 * 80)
        #expect(uploads.job(recording.id) == nil)
        #expect(!FileManager.default.fileExists(atPath: root.appending(path: recording.id).path(percentEncoded: false)), "the recording's files are deleted once Cap has it")

        let log = StorageStub.log.withLock { $0 }
        #expect(log.contains("PUT /segments/video/segment_002.m4s 403"))
        #expect(log.filter { $0 == "PUT /segments/video/segment_002.m4s" }.count == 1, "a refused segment is retried with a fresh link")
        let targetCalls = transport.requests.filter { $0.url?.path().hasSuffix("/segments/targets") == true }.count
        #expect(targetCalls < 4, "links are fetched in batches, not per segment")
    }

    @Test func aRecordingCutShortByACrashIsFinishedOnRelaunch() async throws {
        let root = makeRoot()
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent().deletingLastPathComponent()) }
        StorageStub.failFirst.withLock { $0.removeAll() }
        let completed = CompletionLog()
        let recording = RecordingJob(userId: testCredentials.userId, title: "Cap Recording", format: .init(width: 1080, height: 1920, fps: 30), organizationId: nil, folderId: nil, hasAudio: false)
        do {
            let (uploads, _) = makeUploads(root: root, completed: completed)
            RecordingUploads.markActive(recording.id, true)
            uploads.begin(recording)
            for index in 0...2 {
                try write(RecordedSegment(track: .video, index: index, duration: index == 0 ? 0 : 2, bytes: 32), in: uploads, job: recording.id)
            }
            await waitFor { uploads.job(recording.id)?.segments.allSatisfy { $0.state == RecordedSegment.State.uploaded } == true }
            try await Task.sleep(for: .milliseconds(1200))
            RecordingUploads.markActive(recording.id, false)
        }

        let (relaunched, _) = makeUploads(root: root, completed: completed)
        #expect(relaunched.job(recording.id)?.segments.count == 3)
        await relaunched.resumeAll()
        await waitFor { !completed.isEmpty }
        let completion = try JSONDecoder().decode(RecordingCompletion.self, from: try #require(completed.first))
        #expect(completion.durationSeconds == 4)
        #expect(completion.videoSegments.count == 2)
        #expect(completion.audioSegments.isEmpty)
    }

    @Test func anUploadedSegmentIsOnlyDeletedOnceItsStateIsSaved() async throws {
        let root = makeRoot()
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent().deletingLastPathComponent()) }
        StorageStub.failFirst.withLock { $0.removeAll() }
        let completed = CompletionLog()
        let (uploads, _) = makeUploads(root: root, completed: completed)
        let recording = RecordingJob(userId: testCredentials.userId, title: "Cap Recording", format: .init(width: 1080, height: 1920, fps: 30), organizationId: nil, folderId: nil, hasAudio: false)
        RecordingUploads.markActive(recording.id, true)
        defer { RecordingUploads.markActive(recording.id, false) }
        uploads.begin(recording)
        let segments = (0...2).map { RecordedSegment(track: .video, index: $0, duration: $0 == 0 ? 0 : 2, bytes: 32) }
        for segment in segments { try write(segment, in: uploads, job: recording.id) }
        let directory = uploads.directory(for: recording.id)

        // A file may only be gone once job.json on disk already says it was uploaded, or a crash in
        // between would find a pending segment with nothing to upload.
        func checkInvariant() throws {
            let saved = try? CapJSON.decoder().decode(RecordingJob.self, from: Data(contentsOf: directory.appending(path: "job.json")))
            for segment in segments where !FileManager.default.fileExists(atPath: directory.appending(path: segment.fileName).path(percentEncoded: false)) {
                let state = saved?.segments.first { $0.subpath == segment.subpath }?.state
                #expect(state == .uploaded, "\(segment.fileName) was deleted before its upload was saved")
            }
        }
        for _ in 0..<80 {
            try checkInvariant()
            try await Task.sleep(for: .milliseconds(25))
        }
        await waitFor { segments.allSatisfy { !FileManager.default.fileExists(atPath: directory.appending(path: $0.fileName).path(percentEncoded: false)) } }
        try checkInvariant()
        #expect(segments.allSatisfy { !FileManager.default.fileExists(atPath: directory.appending(path: $0.fileName).path(percentEncoded: false)) }, "files still go once their uploads are saved")
    }

    /// The screen recorder stops at once and Cap uploads the rest; a recording still being captured
    /// in the other process is left alone.
    @Test func aHandedOffRecordingIsFinishedByCapOnce() async throws {
        let root = makeRoot()
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent().deletingLastPathComponent()) }
        StorageStub.failFirst.withLock { $0.removeAll() }
        let completed = CompletionLog()
        let (recorder, recorderTransport) = makeUploads(root: root, completed: completed)
        let (app, _) = makeUploads(root: root, completed: completed, adoptsHandOffs: true)
        let recording = RecordingJob(userId: testCredentials.userId, title: "Screen Recording", format: .init(width: 1170, height: 2532, fps: 30), organizationId: nil, folderId: nil, hasAudio: true)
        let live = RecordingJob(userId: testCredentials.userId, title: "Screen Recording", format: .init(width: 1170, height: 2532, fps: 30), organizationId: nil, folderId: nil, hasAudio: true)
        RecordingUploads.markActive(recording.id, true)
        recorder.begin(recording)
        recorder.begin(live)
        await waitFor { recorder.job(recording.id)?.capId != nil }
        for index in 0...2 {
            try write(RecordedSegment(track: .video, index: index, duration: index == 0 ? 0 : 2, bytes: 48), in: recorder, job: recording.id)
            try write(RecordedSegment(track: .audio, index: index, duration: index == 0 ? 0 : 2, bytes: 16), in: recorder, job: recording.id)
        }
        try write(RecordedSegment(track: .video, index: 0, duration: 0, bytes: 48), in: recorder, job: live.id)

        #expect(await recorder.handOff(recording.id, durationSeconds: 4) == .recording)
        RecordingUploads.markActive(recording.id, false)
        #expect(recorder.job(recording.id) == nil, "the recorder lets go of it")
        #expect(await recorder.handOff(recording.id, durationSeconds: 4) == nil, "nothing is left to hand over")
        let recorderCalls = recorderTransport.requests.count

        await app.adopt()
        await waitFor { !completed.isEmpty }
        try await Task.sleep(for: .milliseconds(300))
        #expect(completed.count == 1, "completed exactly once")
        let completion = try JSONDecoder().decode(RecordingCompletion.self, from: try #require(completed.first))
        #expect(completion.durationSeconds == 4)
        #expect(completion.videoSegments.map(\.index) == [1, 2])
        #expect(completion.audioSegments.map(\.index) == [1, 2])
        #expect(recorderTransport.requests.count == recorderCalls, "nothing more from the recorder")
        #expect(app.job(live.id) == nil, "a recording still being captured elsewhere isn't taken")
        #expect(FileManager.default.fileExists(atPath: root.appending(path: live.id).path(percentEncoded: false)))
    }

    @Test func anotherAccountsRecordingIsDiscarded() async throws {
        let root = makeRoot()
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent().deletingLastPathComponent()) }
        let completed = CompletionLog()
        let (uploads, transport) = makeUploads(root: root, completed: completed)
        let foreign = RecordingJob(userId: "someone_else", title: "Cap Recording", format: .init(width: 720, height: 1280, fps: 30), organizationId: nil, folderId: nil, hasAudio: true)
        uploads.begin(foreign)
        await waitFor { uploads.job(foreign.id) == nil }
        #expect(uploads.job(foreign.id) == nil)
        #expect(transport.requests.isEmpty)
    }
}

@Suite struct SegmentWriterTests {
    final class Collected: Sendable {
        private let state = Mutex<[RecordedSegment]>([])
        func append(_ segment: RecordedSegment) { state.withLock { $0.append(segment) } }
        var all: [RecordedSegment] { state.withLock { $0 } }
    }

    private func frame(_ index: Int, pool: CVPixelBufferPool, format: inout CMVideoFormatDescription?) -> CMSampleBuffer {
        var pixels: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixels)
        if format == nil {
            CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pixels!, formatDescriptionOut: &format)
        }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: CMTime(value: CMTimeValue(1000 + index), timescale: 30), decodeTimeStamp: .invalid)
        var buffer: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: pixels!, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &buffer)
        return buffer!
    }

    /// The writers keep their delegate weakly. Dropping the writer right after `finish` (as the
    /// recorder does) must still deliver the final partial segment.
    @Test func finishDeliversTheTailEvenWhenTheWriterIsReleased() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "segments \(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let collected = Collected()
        var pool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(nil, nil, [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey: 320, kCVPixelBufferHeightKey: 568,
            kCVPixelBufferIOSurfacePropertiesKey: [:],
        ] as CFDictionary, &pool)
        var format: CMVideoFormatDescription?

        var writer: SegmentWriter? = try SegmentWriter(
            directory: directory,
            video: .init(width: 320, height: 568, fps: 30, bitrate: 500_000),
            audio: false,
            onSegment: { collected.append($0) },
            onFailure: { _ in }
        )
        // 5.5 seconds: two full segments and a half-second tail. Frames arrive faster than real time,
        // so a busy machine can drop some in the middle; the last one waits for the encoder.
        for index in 0..<164 {
            writer?.appendVideo(frame(index, pool: pool!, format: &format))
            try await Task.sleep(for: .milliseconds(1))
        }
        try await Task.sleep(for: .milliseconds(300))
        writer?.appendVideo(frame(164, pool: pool!, format: &format))
        let duration: Double = try await withCheckedThrowingContinuation { continuation in
            writer?.finish { continuation.resume(with: $0) }
            writer = nil
        }
        #expect(abs(duration - 5.5) < 0.05)
        let media = collected.all.filter { !$0.isInitialization }
        // Where segments are cut depends on keyframes, and a slow encoder (CI's virtual Macs) can merge the last two.
        #expect(media.count >= 2)
        #expect(media.map(\.index) == Array(1...media.count))
        #expect(abs(media.reduce(0) { $0 + $1.duration } - 5.5) < 0.05, "the recorded tail must not be lost")
        for segment in collected.all {
            #expect(FileManager.default.fileExists(atPath: directory.appending(path: segment.fileName).path(percentEncoded: false)))
        }
    }

    private func pixelPool(width: Int, height: Int) -> CVPixelBufferPool {
        var pool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(nil, nil, [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey: width, kCVPixelBufferHeightKey: height,
            kCVPixelBufferIOSurfacePropertiesKey: [:],
        ] as CFDictionary, &pool)
        return pool!
    }

    /// A frame at `seconds` with no duration, the way the screen capture delivers them.
    private func screenFrame(at seconds: Double, pool: CVPixelBufferPool, format: inout CMVideoFormatDescription?) -> CMSampleBuffer {
        var pixels: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixels)
        if format == nil {
            CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pixels!, formatDescriptionOut: &format)
        }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMTime(seconds: seconds, preferredTimescale: 1_000_000_000), decodeTimeStamp: .invalid)
        var buffer: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: pixels!, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &buffer)
        return buffer!
    }

    /// 16-bit interleaved PCM, like the phone's app audio.
    private func pcm(at seconds: Double, frames: Int, rate: Double, channels: Int) -> CMSampleBuffer {
        var asbd = AudioStreamBasicDescription(
            mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(2 * channels), mFramesPerPacket: 1, mBytesPerFrame: UInt32(2 * channels),
            mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 16, mReserved: 0
        )
        var format: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
        let bytes = frames * 2 * channels
        var samples = [Int16](repeating: 0, count: frames * channels)
        for index in 0..<frames {
            let value = Int16(8000 * sin(2 * Double.pi * 440 * (seconds + Double(index) / rate)))
            for channel in 0..<channels { samples[index * channels + channel] = value }
        }
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil, customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        samples.withUnsafeBytes { _ = CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: bytes) }
        var buffer: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: format!, sampleCount: frames, presentationTimeStamp: CMTime(seconds: seconds, preferredTimescale: CMTimeScale(rate)), packetDescriptions: nil, sampleBufferOut: &buffer)
        return buffer!
    }

    /// The shape of a real screen recording: bursts of frames, long still stretches with no frames,
    /// and app audio that starts late, drops out, and stops before the video. Processing rejects
    /// tracks that don't cover each other, so the writer has to line them up.
    @Test func screenRecordingTracksCoverEachOther() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "screen \(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let collected = Collected()
        let pool = pixelPool(width: 884, height: 1918)
        var format: CMVideoFormatDescription?
        let writer = try SegmentWriter(
            directory: directory,
            video: .init(width: 884, height: 1918, fps: 30, bitrate: 2_500_000),
            audio: true,
            onSegment: { collected.append($0) },
            onFailure: { _ in }
        )
        let base = 5_000.0
        // Frames for 3 s, still for 3.4 s (no frames), frames again until 8 s.
        var times = stride(from: 0.0, to: 3.0, by: 1.0 / 30).map { $0 }
        times += stride(from: 6.4, to: 8.0, by: 1.0 / 30).map { $0 }
        // App audio from 0.8 s, gone between 4 s and 5 s, and stopping at 6.5 s.
        var audio = stride(from: 0.8, to: 4.0, by: 1024.0 / 44_100).map { $0 }
        audio += stride(from: 5.0, to: 6.5, by: 1024.0 / 44_100).map { $0 }
        var events = times.map { (time: $0, video: true) } + audio.map { (time: $0, video: false) }
        events.sort { $0.time < $1.time }
        for event in events {
            if event.video {
                writer.appendVideo(screenFrame(at: base + event.time, pool: pool, format: &format))
            } else {
                writer.appendAudio(pcm(at: base + event.time, frames: 1024, rate: 44_100, channels: 2))
            }
            try await Task.sleep(for: .microseconds(300))
        }
        // Stopped a moment after the last frame.
        let stop = CMTime(seconds: base + 8.4, preferredTimescale: 1_000_000_000)
        let duration: Double = try await withCheckedThrowingContinuation { continuation in
            writer.finish(at: stop) { continuation.resume(with: $0) }
        }
        #expect(abs(duration - 8.4) < 0.05)
        let segments = collected.all.filter { !$0.isInitialization }
        let videoLength = segments.filter { $0.track == .video }.reduce(0) { $0 + $1.duration }
        let audioLength = segments.filter { $0.track == .audio }.reduce(0) { $0 + $1.duration }
        #expect(abs(videoLength - duration) < 0.1, "video \(videoLength) should end at the stop")
        #expect(abs(audioLength - duration) < 0.1, "audio \(audioLength) should cover the video")
        if let keep = ProcessInfo.processInfo.environment["CAP_SEGMENTS_OUT"] {
            try? FileManager.default.removeItem(atPath: keep)
            try FileManager.default.copyItem(at: directory, to: URL(filePath: keep))
        }
    }

    /// A camera recording where the microphone changes partway, as when headphones connect:
    /// the audio format switches and the track must carry on without a gap.
    @Test func cameraRecordingSurvivesAMicrophoneChange() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "camera \(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let collected = Collected()
        let pool = pixelPool(width: 360, height: 640)
        var format: CMVideoFormatDescription?
        let writer = try SegmentWriter(
            directory: directory,
            video: .init(width: 360, height: 640, fps: 30, bitrate: 1_000_000),
            audio: true,
            onSegment: { collected.append($0) },
            onFailure: { _ in }
        )
        let base = 900.0
        let frames = stride(from: 0.0, to: 5.0, by: 1.0 / 30).map { (time: $0, video: true, rate: 0.0) }
        let builtIn = stride(from: 0.0, to: 2.5, by: 960.0 / 48_000).map { (time: $0, video: false, rate: 48_000.0) }
        let headset = stride(from: 2.5, to: 5.0, by: 320.0 / 16_000).map { (time: $0, video: false, rate: 16_000.0) }
        for event in (frames + builtIn + headset).sorted(by: { $0.time < $1.time }) {
            if event.video {
                var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: CMTime(seconds: base + event.time, preferredTimescale: 600), decodeTimeStamp: .invalid)
                var pixels: CVPixelBuffer?
                CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixels)
                if format == nil { CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pixels!, formatDescriptionOut: &format) }
                var buffer: CMSampleBuffer?
                CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: pixels!, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &buffer)
                writer.appendVideo(buffer!)
            } else {
                writer.appendAudio(pcm(at: base + event.time, frames: event.rate == 48_000 ? 960 : 320, rate: event.rate, channels: 1))
            }
            try await Task.sleep(for: .microseconds(200))
        }
        let duration: Double = try await withCheckedThrowingContinuation { continuation in
            writer.finish { continuation.resume(with: $0) }
        }
        #expect(abs(duration - 5.0) < 0.05)
        let audioLength = collected.all.filter { $0.track == .audio && !$0.isInitialization }.reduce(0) { $0 + $1.duration }
        #expect(abs(audioLength - duration) < 0.1, "audio \(audioLength) should cover the video")
        if let keep = ProcessInfo.processInfo.environment["CAP_CAMERA_SEGMENTS_OUT"] {
            try? FileManager.default.removeItem(atPath: keep)
            try FileManager.default.copyItem(at: directory, to: URL(filePath: keep))
        }
    }
}
