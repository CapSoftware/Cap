@preconcurrency import AVFoundation
@testable import CapKit
import CoreImage
import Foundation
import Synchronization
import Testing

/// Screen and camera are recorded by different processes on different clocks; these prove they come out of an export
/// together. Each track flashes white (and the screen beeps) at the same moments on the host clock, with the kinds of
/// trouble real recordings have: tracks starting at different times, 29.97 against 30 fps, timestamp jitter, dropped
/// frames, a camera gap and cuts. The export is then measured frame by frame and sample by sample.
@Suite(.serialized) struct StudioSyncTests {
    static let screenSize = CGSize(width: 360, height: 780)
    static let cameraSize = CGSize(width: 180, height: 320)
    static let screenColor = CIColor(red: 0.1, green: 0.2, blue: 0.75)
    static let cameraColor = CIColor(red: 0.1, green: 0.75, blue: 0.2)

    struct Track {
        var hostStart: Double
        var seconds: Double
        var frameInterval: Double
        var jitter: Double
        var dropEvery: Int?
        var gap: EditRange?
        var color: CIColor
        var size: CGSize
        var beeps: Bool
        /// The microphone goes quiet (no samples at all) over this stretch, as when it's muted mid-recording.
        var audioDropout: EditRange? = nil
        /// No sound after this many seconds, while the picture carries on.
        var audioStopsAt: Double? = nil
    }

    /// Deterministic pseudo-random numbers, so a failure reproduces.
    struct Noise {
        var state: UInt64
        mutating func next() -> Double {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Double(state >> 11) / Double(1 << 53)
        }
    }

    static func flashes(_ times: [Double], at host: Double, interval: Double) -> Bool {
        times.contains { host >= $0 && host < $0 + interval }
    }

    /// Feeds frames and audio in time order, the way a recorder delivers them.
    /// Returns the track's info and the host time of the first frame of each flash, as it was actually stamped.
    static func record(_ track: Track, flashesAt times: [Double], to url: URL, kind: StudioTrackWriter.Settings.Kind) async throws -> (info: StudioTrackInfo, flashFrames: [Double]) {
        var flashFrames: [Double] = []
        var lastWasFlash = false
        let writer = try StudioTrackWriter(url: url, settings: .init(kind: kind, audio: track.beeps))
        let renderer = StudioRenderer.shared
        var noise = Noise(state: UInt64(track.hostStart * 1000))
        var format: CMVideoFormatDescription?
        var audioFormat: CMAudioFormatDescription?
        var asbd = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked, mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &audioFormat)
        let audioChunk = 960
        var nextAudio = 0
        var index = 0
        while true {
            let ideal = Double(index) * track.frameInterval
            guard ideal < track.seconds else { break }
            let host = track.hostStart + ideal + (noise.next() - 0.5) * 2 * track.jitter
            index += 1
            // Audio up to this frame first, as a recorder interleaves it.
            while track.beeps, Double(nextAudio) / 48_000 < ideal {
                let local = Double(nextAudio) / 48_000
                if let stop = track.audioStopsAt, local >= stop { break }
                if let dropout = track.audioDropout, local >= dropout.start, local < dropout.end {
                    nextAudio += audioChunk
                    continue
                }
                let start = track.hostStart + local
                var samples = [Int16](repeating: 0, count: audioChunk)
                for i in 0..<audioChunk {
                    let t = start + Double(i) / 48_000
                    if times.contains(where: { t >= $0 && t < $0 + 0.08 }) { samples[i] = Int16(sin(t * 2 * .pi * 1000) * 20000) }
                }
                var block: CMBlockBuffer?
                CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: audioChunk * 2, blockAllocator: nil, customBlockSource: nil, offsetToData: 0, dataLength: audioChunk * 2, flags: 0, blockBufferOut: &block)
                samples.withUnsafeBytes { _ = CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: audioChunk * 2) }
                var sample: CMSampleBuffer?
                CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: audioFormat!, sampleCount: audioChunk, presentationTimeStamp: CMTime(seconds: start, preferredTimescale: 48_000), packetDescriptions: nil, sampleBufferOut: &sample)
                while !writer.isReadyForAudio { try await Task.sleep(for: .milliseconds(1)) }
                writer.appendAudio(sample!)
                nextAudio += audioChunk
            }
            if let gap = track.gap, ideal >= gap.start, ideal < gap.end { continue }
            if let every = track.dropEvery, index % every == 0, !flashes(times, at: track.hostStart + ideal, interval: track.frameInterval) { continue }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(kCFAllocatorDefault, Int(track.size.width), Int(track.size.height), kCVPixelFormatType_32BGRA, StudioRenderer.bufferAttributes as CFDictionary, &buffer)
            let isFlash = flashes(times, at: track.hostStart + ideal, interval: track.frameInterval)
            if isFlash, !lastWasFlash { flashFrames.append(host) }
            lastWasFlash = isFlash
            let color = isFlash ? CIColor(red: 1, green: 1, blue: 1) : track.color
            renderer.context.render(CIImage(color: color).cropped(to: CGRect(origin: .zero, size: track.size)), to: buffer!, bounds: CGRect(origin: .zero, size: track.size), colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
            if format == nil { CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: buffer!, formatDescriptionOut: &format) }
            var timing = CMSampleTimingInfo(duration: CMTime(seconds: track.frameInterval, preferredTimescale: 90_000), presentationTimeStamp: CMTime(seconds: host, preferredTimescale: 90_000), decodeTimeStamp: .invalid)
            var sample: CMSampleBuffer?
            CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: buffer!, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &sample)
            while !writer.isReadyForVideo { try await Task.sleep(for: .milliseconds(1)) }
            writer.appendVideo(sample!)
        }
        let duration = try await withCheckedThrowingContinuation { continuation in
            writer.finish(at: nil) { continuation.resume(with: $0) }
        }
        var info = try #require(writer.info)
        info.duration = duration
        return (info, flashFrames)
    }

    struct Measured {
        var screenFlashes: [Double] = []
        var cameraFlashes: [Double] = []
        var beeps: [Double] = []
        var cameraHidden: [Double] = []
    }

    static func measure(_ url: URL, screen: CGPoint, camera: CGPoint) async throws -> Measured {
        let asset = AVURLAsset(url: url)
        let reader = try AVAssetReader(asset: asset)
        let videoTrack = try #require(try await asset.loadTracks(withMediaType: .video).first)
        let video = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(video)
        var audio: AVAssetReaderTrackOutput?
        if let audioTrack = try await asset.loadTracks(withMediaType: .audio).first {
            let output = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false, AVNumberOfChannelsKey: 1, AVSampleRateKey: 48_000])
            reader.add(output)
            audio = output
        }
        reader.startReading()
        var measured = Measured()
        var screenLit = false
        var cameraLit = false
        while let sample = video.copyNextSampleBuffer() {
            let time = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            guard let pixels = CMSampleBufferGetImageBuffer(sample) else { continue }
            let s = StudioRenderingTests.pixel(pixels, Int(screen.x), Int(screen.y))
            let c = StudioRenderingTests.pixel(pixels, Int(camera.x), Int(camera.y))
            let screenWhite = s.r > 200 && s.g > 200 && s.b > 200
            let cameraWhite = c.r > 200 && c.g > 200 && c.b > 200
            if screenWhite, !screenLit { measured.screenFlashes.append(time) }
            if cameraWhite, !cameraLit { measured.cameraFlashes.append(time) }
            // Neither the camera's green nor a flash: the bubble isn't there.
            if !(c.g > 150 && c.r < 100) && !cameraWhite { measured.cameraHidden.append(time) }
            screenLit = screenWhite
            cameraLit = cameraWhite
        }
        if let audio {
            var lastLoud = -1.0
            while let sample = audio.copyNextSampleBuffer(), let block = CMSampleBufferGetDataBuffer(sample) {
                let start = CMSampleBufferGetPresentationTimeStamp(sample).seconds
                var length = 0
                var pointer: UnsafeMutablePointer<CChar>?
                CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer)
                guard let pointer else { continue }
                pointer.withMemoryRebound(to: Int16.self, capacity: length / 2) { values in
                    for i in 0..<(length / 2) where abs(Int32(values[i])) > 6000 {
                        let t = start + Double(i) / 48_000
                        // A new beep after a stretch of quiet.
                        if t - lastLoud > 0.2 { measured.beeps.append(t) }
                        lastLoud = t
                    }
                }
            }
        }
        return measured
    }

    @Test func screenCameraAndVoiceStayTogetherThroughCutsAndGaps() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "studio-sync-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        // Host-clock moments both tracks flash at. The camera starts 0.73 s before the screen.
        let base = 5000.0
        let flashTimes = [base + 1.5, base + 5.47, base + 11.03, base + 16.6, base + 28.1]
        // The microphone is muted for two and a half seconds part way, so the voice after it must still land on its picture.
        let screenTrack = Track(hostStart: base + 0.73, seconds: 30, frameInterval: 1.0 / 30, jitter: 0.004, dropEvery: 31, gap: nil, color: Self.screenColor, size: Self.screenSize, beeps: true, audioDropout: EditRange(start: 18, end: 20.5))
        // 29.97 fps, more jitter, every 23rd frame dropped, and nothing for four seconds (a call, say).
        let cameraTrack = Track(hostStart: base, seconds: 31, frameInterval: 1001.0 / 30000, jitter: 0.008, dropEvery: 23, gap: EditRange(start: 21, end: 24), color: Self.cameraColor, size: Self.cameraSize, beeps: false)
        let (screenInfo, screenFlashFrames) = try await Self.record(screenTrack, flashesAt: flashTimes, to: directory.appending(path: "screen.mp4"), kind: .screen)
        let (cameraInfo, cameraFlashFrames) = try await Self.record(cameraTrack, flashesAt: flashTimes, to: directory.appending(path: "camera.mp4"), kind: .camera)
        #expect(abs(screenInfo.hostStart - (base + 0.73)) < 0.01)
        let cameraGap = try #require(cameraInfo.gaps?.first)
        #expect(abs(cameraGap.start - 21) < 0.1 && abs(cameraGap.end - 24) < 0.1)

        let aligned = StudioTrackInfo.align(screen: screenInfo, camera: cameraInfo)
        let screenProject = try #require(aligned.screen)
        let cameraProject = try #require(aligned.camera)
        #expect(abs(screenProject.offset - 0.73) < 0.01)
        let screenAudio = try #require(screenProject.audio)
        let screen = try await StudioTrackSource.load(url: directory.appending(path: "screen.mp4"), offset: screenProject.offset, gaps: screenProject.gaps ?? [], audio: (directory.appending(path: screenAudio.file), screenAudio.offset, screenAudio.duration))
        let camera = try await StudioTrackSource.load(url: directory.appending(path: "camera.mp4"), offset: cameraProject.offset, gaps: cameraProject.gaps ?? [])

        var look = StudioLook.studioDefault
        look.shadow = 0
        look.camera.size = 0.4
        let scene = StudioScene(look: look, screen: screen.info, camera: camera.info)
        // Cuts on either side of flashes and across the camera gap: project time 3-4.5, 13-14 and 22-23 removed.
        let project = StudioProject(title: "Sync", screen: screenProject, camera: cameraProject)
        let clips = [EditRange(start: 0, end: 3), EditRange(start: 4.5, end: 13), EditRange(start: 14, end: 22), EditRange(start: 23, end: project.duration)]
        let timeline = EditTimeline(sourceDuration: project.duration, clips: clips)
        let built = try StudioComposition.build(clips: timeline.clips, screen: screen, camera: camera, music: nil, voiceVolume: 1, scene: scene, longEdge: 960, remembersFrames: false)
        let exported = try await StudioExporter().export(built, to: directory.appending(path: "export.mp4"))

        let layout = StudioLayout(look: look, canvas: built.renderSize, primary: screen.info.displaySize, camera: camera.info.displaySize)
        let screenFrame = try #require(layout.screen?.frame)
        let bubble = try #require(layout.camera?.frame)
        // A point on the screen well away from the bubble, and the bubble's centre.
        let screenPoint = CGPoint(x: screenFrame.minX + screenFrame.width * 0.3, y: screenFrame.minY + screenFrame.height * 0.3)
        let measured = try await Self.measure(exported.url, screen: screenPoint, camera: CGPoint(x: bubble.midX, y: bubble.midY))

        // Where each flash belongs in the edited video. The project starts at the earlier track's first frame.
        let origin = min(screenInfo.hostStart, cameraInfo.hostStart)
        let expected = flashTimes.map { timeline.outputTime(forSource: $0 - origin) }
        print("STUDIO_SYNC expected \(expected.map { String(format: "%.3f", $0) })")
        print("STUDIO_SYNC screen   \(measured.screenFlashes.map { String(format: "%.3f", $0) })")
        print("STUDIO_SYNC camera   \(measured.cameraFlashes.map { String(format: "%.3f", $0) })")
        print("STUDIO_SYNC beeps    \(measured.beeps.map { String(format: "%.3f", $0) })")
        #expect(measured.screenFlashes.count == expected.count)
        #expect(measured.cameraFlashes.count == expected.count)
        #expect(measured.beeps.count == expected.count)
        // Exactly where each flash frame must appear: a recorded frame shows from the first 30 fps output frame at or
        // after its own timestamp, mapped through the cuts. Anything else is a sync error, not rounding.
        func shownAt(_ host: Double) -> Double {
            let output = timeline.outputTime(forSource: host - origin)
            return (output * 30 - 1e-6).rounded(.up) / 30
        }
        for (index, time) in expected.enumerated() {
            guard index < measured.screenFlashes.count, index < measured.cameraFlashes.count, index < measured.beeps.count,
                  index < screenFlashFrames.count, index < cameraFlashFrames.count
            else { break }
            let screenError = measured.screenFlashes[index] - shownAt(screenFlashFrames[index])
            let cameraError = measured.cameraFlashes[index] - shownAt(cameraFlashFrames[index])
            let voiceError = measured.beeps[index] - time
            print("STUDIO_SYNC flash \(index) at \(String(format: "%.3f", time)) s: screen frame \(String(format: "%+.1f", screenError * 1000)) ms, camera frame \(String(format: "%+.1f", cameraError * 1000)) ms, voice \(String(format: "%+.1f", voiceError * 1000)) ms off its exact place")
            #expect(abs(screenError) < 0.002)
            #expect(abs(cameraError) < 0.002)
            // AAC adds a few milliseconds of fixed delay at most.
            #expect(abs(voiceError) < 0.006)
        }
        // In the camera's gap (21-24 s; the camera starts the project), the bubble is gone, not frozen.
        let gapMiddle = timeline.outputTime(forSource: 23.5)
        #expect(measured.cameraHidden.contains { abs($0 - gapMiddle) < 0.1 })
        // And it's back after.
        let afterGap = timeline.outputTime(forSource: 26)
        #expect(!measured.cameraHidden.contains { abs($0 - afterGap) < 0.05 })
        #expect(abs(exported.duration - timeline.outputDuration) < 0.05)
    }

    /// The app or extension can be killed mid-recording. The file must still play up to its last fragment.
    @Test func anUnfinishedTrackStillPlays() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "studio-crash-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appending(path: "camera.mp4")
        let started = Mutex<Double?>(nil)
        do {
            let writer = try StudioTrackWriter(url: url, settings: .init(kind: .camera, audio: false)) { info in started.withLock { $0 = info.hostStart } }
            var format: CMVideoFormatDescription?
            for index in 0..<(30 * 7) {
                var buffer: CVPixelBuffer?
                CVPixelBufferCreate(kCFAllocatorDefault, 180, 320, kCVPixelFormatType_32BGRA, StudioRenderer.bufferAttributes as CFDictionary, &buffer)
                if format == nil { CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: buffer!, formatDescriptionOut: &format) }
                var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: CMTime(value: CMTimeValue(9000 + index), timescale: 30), decodeTimeStamp: .invalid)
                var sample: CMSampleBuffer?
                CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: buffer!, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &sample)
                while !writer.isReadyForVideo { try await Task.sleep(for: .milliseconds(1)) }
                writer.appendVideo(sample!)
            }
            // Give the encoder a moment to write its fragments, then drop the writer without finishing, as a crash would.
            try await Task.sleep(for: .milliseconds(500))
            _ = writer
        }
        #expect(started.withLock { $0 } == 300)
        let duration = try await AVURLAsset(url: url).load(.duration).seconds
        print("STUDIO_SYNC unfinished 7.0 s track plays \(String(format: "%.2f", duration)) s")
        #expect(duration >= 3.9)
    }

    /// A full-size export holds only a few frames at a time, however long the video.
    @Test func exportMemoryStaysFlat() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "studio-memory-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let screenTrack = Track(hostStart: 0, seconds: 8, frameInterval: 1.0 / 30, jitter: 0, dropEvery: nil, gap: nil, color: Self.screenColor, size: CGSize(width: 1178, height: 2556), beeps: true)
        let cameraTrack = Track(hostStart: 0.2, seconds: 8, frameInterval: 1.0 / 30, jitter: 0, dropEvery: nil, gap: nil, color: Self.cameraColor, size: CGSize(width: 720, height: 1280), beeps: false)
        let (screenInfo, _) = try await Self.record(screenTrack, flashesAt: [5, 10], to: directory.appending(path: "screen.mp4"), kind: .screen)
        let (cameraInfo, _) = try await Self.record(cameraTrack, flashesAt: [5, 10], to: directory.appending(path: "camera.mp4"), kind: .camera)
        let aligned = StudioTrackInfo.align(screen: screenInfo, camera: cameraInfo)
        let screen = try await StudioTrackSource.load(url: directory.appending(path: "screen.mp4"), offset: aligned.screen!.offset)
        let camera = try await StudioTrackSource.load(url: directory.appending(path: "camera.mp4"), offset: aligned.camera!.offset)
        let scene = StudioScene(look: .studioDefault, screen: screen.info, camera: camera.info)
        let built = try StudioComposition.build(clips: [EditRange(start: 0, end: 8)], screen: screen, camera: camera, music: nil, voiceVolume: 1, scene: scene, longEdge: StudioLayout.exportLongEdge, remembersFrames: false)
        let before = ProcessStats.footprint()
        let sampler = Task.detached { () -> Double in
            var high = 0.0
            for _ in 0..<3000 {
                if Task.isCancelled { break }
                high = max(high, ProcessStats.footprint().current)
                try? await Task.sleep(for: .milliseconds(20))
            }
            return high
        }
        let result = try await StudioExporter().export(built, to: directory.appending(path: "out.mp4"))
        sampler.cancel()
        let high = await sampler.value
        print("STUDIO_BENCH full-size export \(Int(result.size.width))x\(Int(result.size.height)) \(String(format: "%.1f", result.duration)) s in \(String(format: "%.2f", result.seconds)) s (\(String(format: "%.1f", result.duration / result.seconds))x), memory \(Int(before.current)) MB before, \(Int(high)) MB highest during, \(Int(high - before.current)) MB added")
        // Measured 133-163 MB added on an M4 with hardware codecs and about 245 MB on CI's virtual Macs, which encode in
        // software. Frames piling up over this 240-frame export would add a gigabyte or more, which is what this catches.
        #expect(high - before.current < 400)
    }

    /// Cancelling a render part way returns at once, whatever each feeding loop was waiting on.
    @Test func cancellingARenderReturns() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "studio-cancel-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let track = Track(hostStart: 0, seconds: 6, frameInterval: 1.0 / 30, jitter: 0, dropEvery: nil, gap: nil, color: Self.screenColor, size: CGSize(width: 720, height: 1560), beeps: true)
        _ = try await Self.record(track, flashesAt: [3], to: directory.appending(path: "screen.mp4"), kind: .screen)
        let screen = try await StudioTrackSource.load(url: directory.appending(path: "screen.mp4"), offset: 0)
        let scene = StudioScene(look: .studioDefault, screen: screen.info, camera: nil)
        for delay in [0.0, 0.05, 0.3] {
            let built = try StudioComposition.build(clips: [EditRange(start: 0, end: 6)], screen: screen, camera: nil, music: nil, voiceVolume: 1, scene: scene, longEdge: 1920, remembersFrames: false)
            let exporter = StudioExporter()
            let url = directory.appending(path: "out-\(delay).mp4")
            let started = CFAbsoluteTimeGetCurrent()
            let render = Task { try await exporter.export(built, to: url) }
            try await Task.sleep(for: .seconds(delay))
            exporter.cancel()
            var cancelled = false
            do {
                _ = try await render.value
            } catch StudioExporter.Failure.cancelled {
                cancelled = true
            } catch {
                cancelled = true
            }
            let took = CFAbsoluteTimeGetCurrent() - started - delay
            print("STUDIO_BENCH cancel after \(delay) s returned in \(String(format: "%.2f", took)) s")
            #expect(cancelled)
            #expect(took < 3)
            #expect(!FileManager.default.fileExists(atPath: url.path))
        }
    }

    /// Sound that stops while the picture carries on (a muted microphone, an interruption) must never stop the picture.
    @Test func pictureCarriesOnWhenSoundStops() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "studio-nosound-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let track = Track(hostStart: 200, seconds: 10, frameInterval: 1.0 / 30, jitter: 0.002, dropEvery: nil, gap: nil, color: Self.screenColor, size: Self.screenSize, beeps: true, audioStopsAt: 1.5)
        let (info, _) = try await Self.record(track, flashesAt: [201, 208], to: directory.appending(path: "screen.mp4"), kind: .screen)
        print("STUDIO_SYNC sound stopped at 1.5 s: picture \(String(format: "%.2f", info.duration)) s, sound \(String(format: "%.2f", info.audio?.duration ?? 0)) s")
        #expect(info.duration > 9.9)
        #expect(abs((info.audio?.duration ?? 0) - 1.5) < 0.1)
        let video = try await AVURLAsset(url: directory.appending(path: "screen.mp4")).load(.duration).seconds
        #expect(video > 9.9)
    }

    /// A screen that stops changing sends nothing for a while; its last picture must hold, not be cut out as a gap.
    @Test func aStillScreenIsNotAGap() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "studio-still-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let pause = EditRange(start: 2, end: 3.2)
        let (screen, _) = try await Self.record(Track(hostStart: 0, seconds: 5, frameInterval: 1.0 / 30, jitter: 0, dropEvery: nil, gap: pause, color: Self.screenColor, size: Self.screenSize, beeps: false), flashesAt: [], to: directory.appending(path: "screen.mp4"), kind: .screen)
        #expect(screen.gaps == nil)
        let (camera, _) = try await Self.record(Track(hostStart: 0, seconds: 5, frameInterval: 1.0 / 30, jitter: 0, dropEvery: nil, gap: pause, color: Self.cameraColor, size: Self.cameraSize, beeps: false), flashesAt: [], to: directory.appending(path: "camera.mp4"), kind: .camera)
        #expect(camera.gaps?.count == 1)
    }

    /// When one file fails, recording stops but the healthy file is still closed properly, keeping its picture.
    @Test func aFailureStillClosesTheHealthyFile() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "studio-fail-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appending(path: "camera.mp4")
        let writer = try StudioTrackWriter(url: url, settings: .init(kind: .camera, audio: false))
        var format: CMVideoFormatDescription?
        for index in 0..<(30 * 4) {
            if index == 30 * 2 { writer.markFailed() }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(kCFAllocatorDefault, 180, 320, kCVPixelFormatType_32BGRA, StudioRenderer.bufferAttributes as CFDictionary, &buffer)
            if format == nil { CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: buffer!, formatDescriptionOut: &format) }
            var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: CMTime(value: CMTimeValue(600 + index), timescale: 30), decodeTimeStamp: .invalid)
            var sample: CMSampleBuffer?
            CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: buffer!, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &sample)
            while !writer.isReadyForVideo { try await Task.sleep(for: .milliseconds(1)) }
            writer.appendVideo(sample!)
        }
        #expect(writer.failed)
        let result = try await withCheckedThrowingContinuation { continuation in writer.finish(at: nil) { continuation.resume(with: $0) } }
        // Frames after the failure are refused; the two seconds before it are closed into a complete file.
        #expect(abs(result - 2) < 0.05)
        let duration = try await AVURLAsset(url: url).load(.duration).seconds
        #expect(abs(duration - 2) < 0.05)
    }

    @Test func recordedRangesSkipGaps() {
        let track = StudioProject.Track(file: "c", offset: 1, duration: 10, gaps: [EditRange(start: 6, end: 7), EditRange(start: 2, end: 3), EditRange(start: 9.5, end: 12)])
        #expect(track.recorded == [EditRange(start: 0, end: 2), EditRange(start: 3, end: 6), EditRange(start: 7, end: 9.5)])
        #expect(StudioProject.Track(file: "c", offset: 0, duration: 4).recorded == [EditRange(start: 0, end: 4)])
    }

    /// An hour-long recording cut into hundreds of pieces still rebuilds in milliseconds.
    @Test func longProjectsRebuildFast() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "studio-long-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let short = Track(hostStart: 0, seconds: 3, frameInterval: 1.0 / 30, jitter: 0, dropEvery: nil, gap: nil, color: Self.screenColor, size: Self.screenSize, beeps: false)
        _ = try await Self.record(short, flashesAt: [], to: directory.appending(path: "screen.mp4"), kind: .screen)
        let screen = try await StudioTrackSource.load(url: directory.appending(path: "screen.mp4"), offset: 0)
        // Pretend the source is an hour long by cutting the same 3 s into 600 clips.
        let clips = (0..<600).map { _ in EditRange(start: 0.5, end: 2.5) }
        let scene = StudioScene(look: .studioDefault, screen: screen.info, camera: nil)
        let start = CFAbsoluteTimeGetCurrent()
        let built = try StudioComposition.build(clips: clips, screen: screen, camera: nil, music: nil, voiceVolume: 1, scene: scene, longEdge: 1280, remembersFrames: true)
        let took = (CFAbsoluteTimeGetCurrent() - start) * 1000
        print("STUDIO_BENCH rebuild 600 clips \(String(format: "%.1f", took)) ms")
        #expect(abs(built.duration - 1200) < 0.5)
        #expect(took < 250)
    }
}
