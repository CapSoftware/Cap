@preconcurrency import AVFoundation
@testable import CapKit
import CoreImage
import Foundation
import Testing

@Suite struct StudioLayoutTests {
    let phoneScreen = CGSize(width: 1179, height: 2556)
    let camera = CGSize(width: 720, height: 1280)

    @Test func untouchedLookFillsTheFrame() {
        let canvas = StudioLayout.canvasSize(look: .untouched, primary: phoneScreen, camera: nil, longEdge: StudioLayout.exportLongEdge)
        #expect(canvas.height == 1920)
        #expect(abs(canvas.width / canvas.height - phoneScreen.width / phoneScreen.height) < 0.01)
        let layout = StudioLayout(look: .untouched, canvas: canvas, primary: phoneScreen, camera: nil)
        let frame = try! #require(layout.screen?.frame)
        #expect(abs(frame.width - canvas.width) <= 1)
        #expect(abs(frame.height - canvas.height) <= 1)
        #expect(layout.camera == nil)
    }

    @Test func neverUpscalesSmallVideo() {
        let canvas = StudioLayout.canvasSize(look: .untouched, primary: CGSize(width: 1280, height: 720), camera: nil, longEdge: 1920)
        #expect(canvas == CGSize(width: 1280, height: 720))
    }

    @Test func sizesAreEven() {
        for aspect in StudioAspect.allCases {
            var look = StudioLook.studioDefault
            look.aspect = aspect
            let canvas = StudioLayout.canvasSize(look: look, primary: CGSize(width: 1179, height: 2557), camera: camera, longEdge: 1920)
            #expect(Int(canvas.width) % 2 == 0)
            #expect(Int(canvas.height) % 2 == 0)
            if let ratio = aspect.ratio { #expect(abs(canvas.width / canvas.height - ratio) < 0.01) }
        }
    }

    @Test func paddingInsetsTheVideoAndKeepsItsShape() {
        var look = StudioLook.studioDefault
        look.padding = 0.1
        look.aspect = .square
        let canvas = CGSize(width: 1920, height: 1920)
        let layout = StudioLayout(look: look, canvas: canvas, primary: phoneScreen, camera: nil)
        let frame = try! #require(layout.screen?.frame)
        #expect(frame.minY >= 192 - 1)
        #expect(frame.maxY <= 1920 - 192 + 1)
        #expect(abs(frame.width / frame.height - phoneScreen.width / phoneScreen.height) < 0.01)
        #expect(abs(frame.midX - 960) <= 1)
    }

    @Test func noBackgroundMeansNoPaddingOrCorners() {
        var look = StudioLook.untouched
        look.padding = 0.2
        look.rounding = 0.2
        let canvas = CGSize(width: 886, height: 1920)
        let layout = StudioLayout(look: look, canvas: canvas, primary: phoneScreen, camera: nil)
        #expect(layout.screen?.shape == .rounded(radius: 0))
        #expect(abs((layout.screen?.frame.height ?? 0) - 1920) <= 1)
    }

    @Test func bubbleSitsInTheChosenCorner() {
        var look = StudioLook.studioDefault
        let canvas = CGSize(width: 1080, height: 1920)
        for corner in StudioCorner.allCases {
            look.camera.corner = corner
            let layout = StudioLayout(look: look, canvas: canvas, primary: phoneScreen, camera: camera)
            let bubble = try! #require(layout.camera?.frame)
            #expect(StudioLayout.nearestCorner(to: CGPoint(x: bubble.midX, y: bubble.midY), in: canvas) == corner)
            #expect(CGRect(origin: .zero, size: canvas).contains(bubble))
            #expect(abs(bubble.width - bubble.height) < 0.5)
        }
    }

    @Test func splitStacksScreenOverCameraWhenTall() {
        var look = StudioLook.studioDefault
        look.camera.layout = .split
        look.aspect = .portrait
        let canvas = CGSize(width: 1080, height: 1920)
        let layout = StudioLayout(look: look, canvas: canvas, primary: CGSize(width: 1920, height: 1080), camera: camera)
        let screen = try! #require(layout.screen?.frame)
        let cam = try! #require(layout.camera?.frame)
        #expect(screen.maxY < cam.minY)
        #expect(cam.height >= canvas.height / 4)
        #expect(!screen.intersects(cam))
    }

    @Test func splitIsSideBySideWhenWide() {
        var look = StudioLook.studioDefault
        look.camera.layout = .split
        look.aspect = .landscape
        let canvas = CGSize(width: 1920, height: 1080)
        let layout = StudioLayout(look: look, canvas: canvas, primary: CGSize(width: 1920, height: 1080), camera: camera)
        let screen = try! #require(layout.screen?.frame)
        let cam = try! #require(layout.camera?.frame)
        #expect(screen.maxX < cam.minX)
    }

    @Test func missingCameraFallsBackToScreen() {
        var look = StudioLook.studioDefault
        look.camera.layout = .cameraOnly
        let layout = StudioLayout(look: look, canvas: CGSize(width: 1080, height: 1920), primary: phoneScreen, camera: nil)
        #expect(layout.screen != nil)
        #expect(layout.camera == nil)
    }

    @Test func cameraOnlyFillsTheArea() {
        var look = StudioLook.studioDefault
        look.camera.layout = .cameraOnly
        look.padding = 0
        let canvas = CGSize(width: 1080, height: 1920)
        let layout = StudioLayout(look: look, canvas: canvas, primary: phoneScreen, camera: camera)
        #expect(layout.screen == nil)
        #expect(layout.camera?.frame == CGRect(origin: .zero, size: canvas))
    }

    @Test func identityLook() {
        #expect(StudioLook.untouched.isIdentity(hasCamera: false))
        #expect(!StudioLook.untouched.isIdentity(hasCamera: true))
        #expect(!StudioLook.studioDefault.isIdentity(hasCamera: false))
        var cropped = StudioLook.untouched
        cropped.aspect = .square
        #expect(!cropped.isIdentity(hasCamera: false))
    }
}

@Suite struct StudioProjectTests {
    @Test func tracksLineUpOnTheHostClock() {
        let screen = StudioTrackInfo(file: "screen.mp4", hostStart: 1000.4, duration: 30)
        let camera = StudioTrackInfo(file: "camera.mp4", hostStart: 1000.1, duration: 29)
        let aligned = StudioTrackInfo.align(screen: screen, camera: camera)
        #expect(aligned.camera?.offset == 0)
        #expect(abs((aligned.screen?.offset ?? 0) - 0.3) < 1e-9)
        let project = StudioProject(title: "t", screen: aligned.screen, camera: aligned.camera)
        #expect(abs(project.duration - 30.3) < 1e-9)
    }

    @Test func emptyTracksAreDropped() {
        let aligned = StudioTrackInfo.align(screen: StudioTrackInfo(file: "s", hostStart: 5, duration: 0), camera: StudioTrackInfo(file: "c", hostStart: 6, duration: 4))
        #expect(aligned.screen == nil)
        #expect(aligned.camera?.offset == 0)
    }

    @Test func storeRoundTripsNewestFirst() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "studio-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = StudioStore(root: root)
        var old = StudioProject(title: "Old", createdAt: Date(timeIntervalSince1970: 100), camera: .init(file: "camera.mp4", offset: 0, duration: 3))
        old.music = StudioMusic(source: .builtIn("lofi"), title: "Lofi")
        old.look.camera.corner = .topLeading
        old.clips = [EditRange(start: 0.5, end: 2)]
        let new = StudioProject(title: "New", createdAt: Date(timeIntervalSince1970: 200), screen: .init(file: "screen.mp4", offset: 0, duration: 3))
        try store.save(old)
        try store.save(new)
        try FileManager.default.createDirectory(at: store.directory(for: "half-written"), withIntermediateDirectories: true)
        let all = store.all()
        #expect(all.map(\.title) == ["New", "Old"])
        #expect(all[1] == old)
        #expect(all[1].timeline.clips == [EditRange(start: 0.5, end: 2)])
        store.delete(old.id)
        #expect(store.all().map(\.title) == ["New"])
    }

    @Test func screenRequestIsTakenOnceAndExpires() {
        let root = FileManager.default.temporaryDirectory.appending(path: "studio-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = StudioStore(root: root)
        let now = Date()
        StudioScreenRequest.set(.init(projectId: "p1", ownerId: "user_a", requestedAt: now), in: store)
        #expect(StudioScreenRequest.peek(in: store, now: now.addingTimeInterval(5))?.projectId == "p1")
        let taken = StudioScreenRequest.take(in: store, now: now.addingTimeInterval(5))
        #expect(taken?.projectId == "p1")
        #expect(taken?.ownerId == "user_a")
        #expect(StudioScreenRequest.take(in: store, now: now.addingTimeInterval(5)) == nil)
        StudioScreenRequest.set(.init(projectId: "p2", ownerId: "user_a", requestedAt: now), in: store)
        #expect(StudioScreenRequest.take(in: store, now: now.addingTimeInterval(StudioScreenRequest.lifetime + 1)) == nil)
    }

    @Test func draftsBelongToOneAccount() throws {
        let group = "test.studio.\(UUID().uuidString)"
        let first = StudioStore.shared(owner: "user_a", appGroup: group)
        let second = StudioStore.shared(owner: "user_b", appGroup: group)
        defer {
            try? FileManager.default.removeItem(at: first.root)
            try? FileManager.default.removeItem(at: second.root)
        }
        try first.save(StudioProject(title: "Mine", camera: .init(file: "camera.mp4", offset: 0, duration: 3)))
        #expect(first.all().map(\.title) == ["Mine"])
        #expect(second.all().isEmpty)
        #expect(first.root != StudioStore.requests(appGroup: group).root)
        #expect(StudioStore.folderName(for: "../../etc") == "etc")
        #expect(StudioStore.folderName(for: "") == "unknown")
        #expect(StudioStore.folderName(for: "user_9x-Q") == "user_9x-Q")
    }

    @Test func lookDecodesFromEveryBackgroundKind() throws {
        let backgrounds: [StudioBackground] = [.none, .color(StudioColor(1, 2, 3)), StudioBackground.gradients[3], .wallpaper("sonoma"), .image("bg.jpg")]
        for background in backgrounds {
            var look = StudioLook.studioDefault
            look.background = background
            let data = try JSONEncoder().encode(look)
            #expect(try JSONDecoder().decode(StudioLook.self, from: data) == look)
        }
    }
}

/// Real pixels through the real renderer and compositor, on this Mac's GPU.
@Suite(.serialized) struct StudioRenderingTests {
    static func solid(_ size: CGSize, _ color: CIColor, renderer: StudioRenderer) -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, Int(size.width), Int(size.height), kCVPixelFormatType_32BGRA, StudioRenderer.bufferAttributes as CFDictionary, &buffer)
        renderer.context.render(CIImage(color: color).cropped(to: CGRect(origin: .zero, size: size)), to: buffer!, bounds: CGRect(origin: .zero, size: size), colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
        return buffer!
    }

    /// Top-left origin, like the layout.
    static func pixel(_ buffer: CVPixelBuffer, _ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let row = CVPixelBufferGetBytesPerRow(buffer)
        let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
        let p = base + y * row + x * 4
        return (Int(p[2]), Int(p[1]), Int(p[0]))
    }

    @Test func drawsBackgroundScreenAndBubbleWhereTheLayoutSays() throws {
        let renderer = StudioRenderer()
        let screenSize = CGSize(width: 590, height: 1278)
        let cameraSize = CGSize(width: 360, height: 640)
        var look = StudioLook.studioDefault
        look.background = .color(StudioColor(0, 0, 255))
        look.shadow = 0
        look.padding = 0.1
        look.aspect = .portrait
        let scene = StudioScene(look: look, screen: StudioSourceInfo(naturalSize: screenSize), camera: StudioSourceInfo(naturalSize: cameraSize), renderer: renderer)
        let canvas = CGSize(width: 1080, height: 1920)
        let output = try #require(renderer.render(scene: scene, screen: Self.solid(screenSize, CIColor(red: 1, green: 0, blue: 0), renderer: renderer), camera: Self.solid(cameraSize, CIColor(red: 0, green: 1, blue: 0), renderer: renderer), size: canvas))
        let layout = StudioLayout(look: look, canvas: canvas, primary: screenSize, camera: cameraSize)
        let screen = try #require(layout.screen?.frame)
        let bubble = try #require(layout.camera?.frame)
        #expect(Self.pixel(output, 5, 5) == (0, 0, 255))
        let red = Self.pixel(output, Int(screen.midX), Int(screen.minY + 40))
        #expect(red.r > 240 && red.g < 15 && red.b < 15)
        let green = Self.pixel(output, Int(bubble.midX), Int(bubble.midY))
        #expect(green.g > 240 && green.r < 15)
        // Outside the circle but inside its square: the screen shows through.
        let corner = Self.pixel(output, Int(bubble.minX + 4), Int(bubble.minY + 4))
        #expect(corner.g < 40)
        // The screen's rounded corner shows background.
        let screenCorner = Self.pixel(output, Int(screen.minX + 2), Int(screen.minY + 2))
        #expect(screenCorner.b > 200 && screenCorner.r < 60)
    }

    @Test func lookChangesApplyToTheNextFrameWithoutRebuilding() throws {
        let renderer = StudioRenderer()
        let size = CGSize(width: 400, height: 800)
        let scene = StudioScene(look: .untouched, screen: StudioSourceInfo(naturalSize: size), camera: nil, renderer: renderer)
        let red = Self.solid(size, CIColor(red: 1, green: 0, blue: 0), renderer: renderer)
        let before = try #require(renderer.render(scene: scene, screen: red, camera: nil, size: size))
        #expect(Self.pixel(before, 2, 2).r > 240)
        scene.update { $0.look.background = .color(StudioColor(0, 255, 0)); $0.look.padding = 0.1 }
        let after = try #require(renderer.render(scene: scene, screen: red, camera: nil, size: size))
        #expect(Self.pixel(after, 2, 2).g > 240)
    }

    @Test func rotatedSourcesAreUpright() throws {
        let renderer = StudioRenderer()
        // Landscape pixels tagged as portrait, like a phone camera file.
        let natural = CGSize(width: 640, height: 360)
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, 640, 360, kCVPixelFormatType_32BGRA, StudioRenderer.bufferAttributes as CFDictionary, &buffer)
        // Left half red, right half blue.
        let image = CIImage(color: CIColor(red: 1, green: 0, blue: 0)).cropped(to: CGRect(x: 0, y: 0, width: 320, height: 360))
            .composited(over: CIImage(color: CIColor(red: 0, green: 0, blue: 1)).cropped(to: CGRect(x: 0, y: 0, width: 640, height: 360)))
        renderer.context.render(image, to: buffer!, bounds: CGRect(x: 0, y: 0, width: 640, height: 360), colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
        let info = StudioSourceInfo(naturalSize: natural, transform: CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 360, ty: 0))
        #expect(info.displaySize == CGSize(width: 360, height: 640))
        let scene = StudioScene(look: .untouched, screen: info, camera: nil, renderer: renderer)
        let output = try #require(renderer.render(scene: scene, screen: buffer, camera: nil, size: CGSize(width: 360, height: 640)))
        // Rotated a quarter turn clockwise, the left (red) half ends up on top.
        #expect(Self.pixel(output, 180, 100).r > 200)
        #expect(Self.pixel(output, 180, 540).b > 200)
    }

    @Test func pausedRedrawUsesTheFrameJustDrawn() throws {
        let renderer = StudioRenderer()
        let size = CGSize(width: 64, height: 128)
        let scene = StudioScene(look: .untouched, screen: StudioSourceInfo(naturalSize: size), camera: nil, renderer: renderer)
        let buffer = Self.solid(size, CIColor(red: 1, green: 0, blue: 0), renderer: renderer)
        // Frames composed while playing later in the video, then a seek back to 11 s.
        for index in 0..<10 { scene.remember(.init(time: CMTime(seconds: 24 + Double(index) / 30, preferredTimescale: 600), screen: buffer, camera: nil, size: size)) }
        scene.remember(.init(time: CMTime(seconds: 11.2, preferredTimescale: 600), screen: buffer, camera: nil, size: size))
        #expect(scene.rememberedTimes.count == StudioScene.rememberedFrames)
        #expect(scene.renderStill(near: CMTime(seconds: 11.21, preferredTimescale: 600)) != nil)
        #expect(scene.renderStill(near: CMTime(seconds: 5, preferredTimescale: 600)) == nil)
    }

    @Test func frameCostStaysSmall() throws {
        let renderer = StudioRenderer()
        let screenSize = CGSize(width: 1179, height: 2556)
        let cameraSize = CGSize(width: 720, height: 1280)
        let scene = StudioScene(look: .studioDefault, screen: StudioSourceInfo(naturalSize: screenSize), camera: StudioSourceInfo(naturalSize: cameraSize), renderer: renderer)
        let screen = Self.solid(screenSize, CIColor(red: 0.9, green: 0.9, blue: 0.9), renderer: renderer)
        let camera = Self.solid(cameraSize, CIColor(red: 0.5, green: 0.4, blue: 0.3), renderer: renderer)
        let canvas = StudioLayout.canvasSize(look: .studioDefault, primary: screenSize, camera: cameraSize, longEdge: StudioLayout.exportLongEdge)
        _ = renderer.render(scene: scene, screen: screen, camera: camera, size: canvas)
        var times: [Double] = []
        for _ in 0..<60 {
            let start = CFAbsoluteTimeGetCurrent()
            _ = renderer.render(scene: scene, screen: screen, camera: camera, size: canvas)
            times.append((CFAbsoluteTimeGetCurrent() - start) * 1000)
        }
        times.sort()
        let p50 = times[times.count / 2]
        let p95 = times[Int(Double(times.count) * 0.95)]
        print("STUDIO_BENCH render \(Int(canvas.width))x\(Int(canvas.height)) p50 \(String(format: "%.2f", p50)) ms p95 \(String(format: "%.2f", p95)) ms")
        // An M4 measures about 1.2 ms p50 and 1.5 ms p95; CI's virtual Macs share a paravirtual GPU with other suites
        // and reach 18 ms p50, 51 ms p95. Redrawing the cached background every frame would cost hundreds.
        #expect(p50 < 33)
        #expect(p95 < 100)
    }
}

/// Records real files with the writer, composes them and exports, as the app does.
@Suite(.serialized) struct StudioPipelineTests {
    static func writeTrack(to url: URL, size: CGSize, seconds: Double, hostStart: Double, color: CIColor, audio: Bool) throws -> StudioTrackWriter {
        let writer = try StudioTrackWriter(url: url, settings: .init(kind: .camera, audio: false))
        let renderer = StudioRenderer.shared
        var format: CMVideoFormatDescription?
        let frames = Int(seconds * 30)
        for index in 0..<frames {
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(kCFAllocatorDefault, Int(size.width), Int(size.height), kCVPixelFormatType_32BGRA, StudioRenderer.bufferAttributes as CFDictionary, &buffer)
            // A bar sweeping across, so every frame differs like real video.
            let x = Double(index % 30) / 30 * size.width
            let image = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: CGRect(x: x, y: 0, width: 20, height: size.height))
                .composited(over: CIImage(color: color).cropped(to: CGRect(origin: .zero, size: size)))
            renderer.context.render(image, to: buffer!, bounds: CGRect(origin: .zero, size: size), colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
            if format == nil { CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: buffer!, formatDescriptionOut: &format) }
            var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: CMTime(seconds: hostStart + Double(index) / 30, preferredTimescale: 90_000), decodeTimeStamp: .invalid)
            var sample: CMSampleBuffer?
            CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: buffer!, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &sample)
            // Real time isn't needed; the writer only asks to be fed no faster than it can take.
            while !writer.isReadyForVideo { usleep(1000) }
            writer.appendVideo(sample!)
        }
        return writer
    }

    static func finish(_ writer: StudioTrackWriter) async throws -> Double {
        try await withCheckedThrowingContinuation { continuation in
            writer.finish(at: nil) { continuation.resume(with: $0) }
        }
    }

    @Test func recordsComposesAndExports() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "studio-pipeline-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let screenSize = CGSize(width: 590, height: 1278)
        let cameraSize = CGSize(width: 360, height: 640)
        let screenWriter = try Self.writeTrack(to: directory.appending(path: "screen.mp4"), size: screenSize, seconds: 4, hostStart: 100.5, color: CIColor(red: 0.2, green: 0.2, blue: 0.8), audio: false)
        let cameraWriter = try Self.writeTrack(to: directory.appending(path: "camera.mp4"), size: cameraSize, seconds: 4, hostStart: 100, color: CIColor(red: 0.8, green: 0.5, blue: 0.2), audio: false)
        #expect(screenWriter.hostStart == 100.5)
        let screenDuration = try await Self.finish(screenWriter)
        let cameraDuration = try await Self.finish(cameraWriter)
        #expect(abs(screenDuration - 4) < 0.05)
        let aligned = StudioTrackInfo.align(
            screen: StudioTrackInfo(file: "screen.mp4", hostStart: 100.5, duration: screenDuration),
            camera: StudioTrackInfo(file: "camera.mp4", hostStart: 100, duration: cameraDuration)
        )
        let project = StudioProject(title: "Pipeline", screen: aligned.screen, camera: aligned.camera)
        #expect(abs(project.duration - 4.5) < 0.05)

        let screen = try await StudioTrackSource.load(url: directory.appending(path: "screen.mp4"), offset: aligned.screen!.offset)
        let camera = try await StudioTrackSource.load(url: directory.appending(path: "camera.mp4"), offset: aligned.camera!.offset)
        let scene = StudioScene(look: .studioDefault, screen: screen.info, camera: camera.info)
        var timeline = project.timeline
        timeline = timeline.splitting(atOutput: 1)!.splitting(atOutput: 2)!.deleting(clipAt: 1)!
        let built = try StudioComposition.build(clips: timeline.clips, screen: screen, camera: camera, music: nil, voiceVolume: 1, scene: scene, longEdge: 1280, remembersFrames: false)
        #expect(abs(built.duration - timeline.outputDuration) < 0.02)

        let out = directory.appending(path: "export.mp4")
        let export = try #require(AVAssetExportSession(asset: built.composition, presetName: AVAssetExportPresetHighestQuality))
        export.videoComposition = built.videoComposition
        export.audioMix = built.audioMix
        let started = CFAbsoluteTimeGetCurrent()
        try await export.export(to: out, as: .mp4)
        let took = CFAbsoluteTimeGetCurrent() - started
        print("STUDIO_BENCH export \(String(format: "%.2f", built.duration)) s video in \(String(format: "%.2f", took)) s (\(String(format: "%.1f", built.duration / took))x realtime)")
        let result = AVURLAsset(url: out)
        let track = try #require(try await result.loadTracks(withMediaType: .video).first)
        let size = try await track.load(.naturalSize)
        #expect(size == built.renderSize)
        #expect(abs(try await result.load(.duration).seconds - built.duration) < 0.1)

        // The same edit through Cap's own exporter, with music mixed in.
        let musicURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../Cap/Resources/Studio/Music/lofi-beats-mirostar.m4a").standardized
        let music = try await StudioMusicSource.load(url: musicURL, volume: 0.4, offset: 2)
        let withMusic = try StudioComposition.build(clips: timeline.clips, screen: screen, camera: camera, music: music, voiceVolume: 1, scene: scene.frozen(), longEdge: 1920, remembersFrames: false)
        let ours = try await StudioExporter().export(withMusic, to: directory.appending(path: "ours.mp4"))
        print("STUDIO_BENCH exporter \(Int(ours.size.width))x\(Int(ours.size.height)) \(String(format: "%.2f", ours.duration)) s in \(String(format: "%.2f", ours.seconds)) s (\(String(format: "%.1f", ours.duration / ours.seconds))x realtime), \(ours.bytes / 1024) KB, \(Int(Double(ours.bytes) * 8 / ours.duration / 1000)) kbps")
        let oursAsset = AVURLAsset(url: ours.url)
        #expect(try await oursAsset.loadTracks(withMediaType: .audio).count == 1)
        #expect(abs(try await oursAsset.load(.duration).seconds - withMusic.duration) < 0.1)
        let waveform = await StudioWaveform.peaks(url: musicURL, count: 100)
        #expect(waveform.count == 100)
        #expect(waveform.max() == 1)

        // The first exported frame is the composed one: background at the edge, screen in the middle.
        let generator = AVAssetImageGenerator(asset: result)
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let (frame, _) = try await generator.image(at: CMTime(value: 1, timescale: 2))
        let context = CIContext()
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(nil, frame.width, frame.height, kCVPixelFormatType_32BGRA, StudioRenderer.bufferAttributes as CFDictionary, &buffer)
        context.render(CIImage(cgImage: frame), to: buffer!)
        let edge = StudioRenderingTests.pixel(buffer!, 3, 3)
        // Cap's default gradient starts blue at the top left.
        #expect(edge.b > 150 && edge.r < 150)
    }
}
