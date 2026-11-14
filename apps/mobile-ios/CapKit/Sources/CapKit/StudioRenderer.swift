@preconcurrency import AVFoundation
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import ImageIO
import Metal
import QuartzCore
import Synchronization

/// What one source contributes to a frame: its shape as recorded, and how it was rotated.
public struct StudioSourceInfo: Sendable, Equatable {
    /// Pixel size of the decoded frames.
    public var naturalSize: CGSize
    public var transform: CGAffineTransform

    public init(naturalSize: CGSize, transform: CGAffineTransform = .identity) {
        self.naturalSize = naturalSize
        self.transform = transform
    }

    /// The size a viewer sees, after rotation.
    public var displaySize: CGSize {
        let rect = CGRect(origin: .zero, size: naturalSize).applying(transform)
        return CGSize(width: abs(rect.width), height: abs(rect.height))
    }

    /// Video tracks only ever rotate by quarter turns.
    var orientation: CGImagePropertyOrientation {
        let t = transform
        if t.a == 0, t.b == 1, t.c == -1, t.d == 0 { return .right }
        if t.a == 0, t.b == -1, t.c == 1, t.d == 0 { return .left }
        if t.a == -1, t.d == -1 { return .down }
        return .up
    }
}

/// Everything about a frame that isn't the video itself. Changing the look while the editor is up only swaps this;
/// nothing is rebuilt and nothing is decoded again.
public final class StudioScene: @unchecked Sendable {
    public struct State: Sendable {
        public var look: StudioLook
        public var screen: StudioSourceInfo?
        public var camera: StudioSourceInfo?
        /// Opaque pictures for wallpapers and photos, keyed by the background's name.
        public var backgroundImage: CGImage?
    }

    private let state: Mutex<(value: State, generation: Int)>
    /// Newest last.
    private let frames = Mutex<[Frame]>([])
    public let renderer: StudioRenderer

    public init(look: StudioLook, screen: StudioSourceInfo?, camera: StudioSourceInfo?, backgroundImage: CGImage? = nil, renderer: StudioRenderer = .shared) {
        state = Mutex((State(look: look, screen: screen, camera: camera, backgroundImage: backgroundImage), 0))
        self.renderer = renderer
    }

    public var current: (state: State, generation: Int) {
        state.withLock { ($0.value, $0.generation) }
    }

    public func update(_ change: (inout State) -> Void) {
        state.withLock {
            change(&$0.value)
            $0.generation += 1
        }
    }

    /// A copy that never changes, for exporting while the editor carries on.
    public func frozen() -> StudioScene {
        let value = current.state
        return StudioScene(look: value.look, screen: value.screen, camera: value.camera, backgroundImage: value.backgroundImage, renderer: renderer)
    }

    // MARK: Last frames

    struct Frame: @unchecked Sendable {
        let time: CMTime
        let screen: CVPixelBuffer?
        let camera: CVPixelBuffer?
        let size: CGSize
    }

    /// The compositor keeps the last few source frames, so a paused preview can be redrawn with a new look without
    /// asking the decoder for anything.
    /// Keeps the most recently composed frames, whatever their times: after a seek back, the frame just drawn is
    /// the one a redraw needs, even though frames from later in the video were composed before it.
    func remember(_ frame: Frame) {
        frames.withLock { frames in
            frames.removeAll { $0.time == frame.time }
            frames.append(frame)
            if frames.count > Self.rememberedFrames { frames.removeFirst(frames.count - Self.rememberedFrames) }
        }
    }

    static let rememberedFrames = 6

    public func forgetFrames() {
        frames.withLock { $0.removeAll() }
    }

    /// For diagnostics: the composition times of the frames kept.
    public var rememberedTimes: [Double] {
        frames.withLock { $0.map(\.time.seconds) }
    }

    /// Redraws the remembered frame closest to `time` with the current look. Nil if nothing near it was decoded.
    public func renderStill(near time: CMTime, tolerance: Double = 0.25) -> CVPixelBuffer? {
        let frame = frames.withLock { frames in
            frames.min { abs(CMTimeSubtract($0.time, time).seconds) < abs(CMTimeSubtract($1.time, time).seconds) }
        }
        guard let frame, abs(CMTimeSubtract(frame.time, time).seconds) <= tolerance else { return nil }
        return renderer.render(scene: self, screen: frame.screen, camera: frame.camera, size: frame.size)
    }
}

/// Draws Studio frames with Core Image on the GPU. One shared instance: its caches are what make frames cheap.
public final class StudioRenderer: @unchecked Sendable {
    public static let shared = StudioRenderer()

    public let context: CIContext
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    private let cache = Mutex<Cache?>(nil)
    private let poolLock = NSLock()
    private var poolSize = CGSize.zero
    private var pool: CVPixelBufferPool?

    /// The parts of a frame that don't move, drawn once per look and size: background, shadows.
    private struct Cache {
        let key: CacheKey
        let base: CIImage
        let layout: StudioLayout
        let screenMask: CIImage?
        let cameraMask: CIImage?
    }

    private struct CacheKey: Equatable {
        let look: StudioLook
        let size: CGSize
        let screen: CGSize?
        let camera: CGSize?
        let image: ObjectIdentifier?
    }

    public init(device: MTLDevice? = MTLCreateSystemDefaultDevice()) {
        let options: [CIContextOption: Any] = [
            .cacheIntermediates: false,
            .workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            .outputColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            // Half floats would double the bandwidth for no visible gain on 8-bit video.
            .workingFormat: CIFormat.RGBA8,
            .name: "Cap Studio",
        ]
        if let device {
            context = CIContext(mtlDevice: device, options: options)
        } else {
            context = CIContext(options: options)
        }
    }

    /// Core Image compiles its kernels the first time a graph is drawn, which costs hundreds of milliseconds. Drawing
    /// one throwaway frame of the same shape while the video loads moves that cost off the first frame people see,
    /// and leaves the background and masks for this look already cached.
    public func prewarm(scene: StudioScene, size: CGSize) {
        let state = scene.current.state
        func dummy(_ info: StudioSourceInfo?) -> CVPixelBuffer? {
            guard info != nil else { return nil }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, [kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()] as CFDictionary, &buffer)
            return buffer
        }
        _ = render(scene: scene, screen: dummy(state.screen), camera: dummy(state.camera), size: size)
    }

    /// Renders into a pixel buffer from the renderer's own pool. For stills and tests; the compositor renders into
    /// buffers AVFoundation hands it.
    public func render(scene: StudioScene, screen: CVPixelBuffer?, camera: CVPixelBuffer?, size: CGSize) -> CVPixelBuffer? {
        guard let output = makeBuffer(size: size) else { return nil }
        render(scene: scene, screen: screen, camera: camera, into: output)
        return output
    }

    public func render(scene: StudioScene, screen: CVPixelBuffer?, camera: CVPixelBuffer?, into output: CVPixelBuffer) {
        let size = CGSize(width: CVPixelBufferGetWidth(output), height: CVPixelBufferGetHeight(output))
        let state = scene.current.state
        let cache = cached(state: state, size: size)
        var image = cache.base
        if let placement = cache.layout.screen, let screen, let info = state.screen {
            image = composite(screen, info: info, placement: placement, mask: cache.screenMask, canvas: size, over: image)
        }
        if let placement = cache.layout.camera, let camera, let info = state.camera {
            image = composite(camera, info: info, placement: placement, mask: cache.cameraMask, canvas: size, over: image)
        }
        context.render(image, to: output, bounds: CGRect(origin: .zero, size: size), colorSpace: colorSpace)
    }

    /// Places a frame: rotate upright, scale to cover its slot, crop to the slot's shape, lay over what's below.
    private func composite(_ buffer: CVPixelBuffer, info: StudioSourceInfo, placement: StudioLayout.Placement, mask: CIImage?, canvas: CGSize, over below: CIImage) -> CIImage {
        var source = CIImage(cvPixelBuffer: buffer)
        if info.orientation != .up { source = source.oriented(info.orientation) }
        let extent = source.extent
        let slot = Self.flip(placement.frame, in: canvas)
        let fill = StudioLayout.fill(extent.size, into: slot)
        let placed = source
            .transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY)
                .concatenating(CGAffineTransform(scaleX: fill.scale, y: fill.scale))
                .concatenating(CGAffineTransform(translationX: fill.origin.x, y: fill.origin.y)))
            .cropped(to: slot)
        guard let mask else { return placed.composited(over: below) }
        return placed.applyingFilter("CIBlendWithAlphaMask", parameters: [
            kCIInputBackgroundImageKey: below,
            kCIInputMaskImageKey: mask,
        ])
    }

    private func cached(state: StudioScene.State, size: CGSize) -> Cache {
        let key = CacheKey(look: state.look, size: size, screen: state.screen?.displaySize, camera: state.camera?.displaySize, image: state.backgroundImage.map(ObjectIdentifier.init))
        if let cache = cache.withLock({ $0 }), cache.key == key { return cache }
        let layout = StudioLayout(look: state.look, canvas: size, primary: state.screen?.displaySize, camera: state.camera?.displaySize)
        let screenMask = layout.screen.flatMap { mask(for: $0, canvas: size) }
        let cameraMask = layout.camera.flatMap { mask(for: $0, canvas: size) }
        var base = background(state.look.background, image: state.backgroundImage, size: size)
        let strength = state.look.effectiveShadow
        if strength > 0 {
            for placement in [layout.screen, layout.camera].compactMap({ $0 }) {
                base = shadow(for: placement, strength: strength, canvas: size).composited(over: base)
            }
        }
        // Drawn once into a buffer of its own, so each frame samples one texture instead of re-running blurs.
        let buffer = makeStaticBuffer(size: size)
        if let buffer {
            context.render(base.cropped(to: CGRect(origin: .zero, size: size)), to: buffer, bounds: CGRect(origin: .zero, size: size), colorSpace: colorSpace)
        }
        let flattened = buffer.map { CIImage(cvPixelBuffer: $0) } ?? base
        let made = Cache(key: key, base: flattened, layout: layout, screenMask: screenMask, cameraMask: cameraMask)
        cache.withLock { $0 = made }
        return made
    }

    private func mask(for placement: StudioLayout.Placement, canvas: CGSize) -> CIImage? {
        let rect = Self.flip(placement.frame, in: canvas)
        let radius: Double = switch placement.shape {
        case let .rounded(radius): radius
        case .circle: min(rect.width, rect.height) / 2
        }
        guard radius >= 0.5 else { return nil }
        let generator = CIFilter.roundedRectangleGenerator()
        generator.extent = rect
        generator.radius = Float(radius)
        generator.color = CIColor.white
        guard let shape = generator.outputImage else { return nil }
        // The mask is drawn once into a texture, with a soft one-pixel edge, so curves stay smooth when scaled.
        let softened = shape.applyingGaussianBlur(sigma: 0.6).cropped(to: CGRect(origin: .zero, size: canvas))
        guard let buffer = makeStaticBuffer(size: canvas) else { return softened }
        context.render(softened.composited(over: CIImage(color: .clear).cropped(to: CGRect(origin: .zero, size: canvas))), to: buffer, bounds: CGRect(origin: .zero, size: canvas), colorSpace: colorSpace)
        return CIImage(cvPixelBuffer: buffer)
    }

    private func shadow(for placement: StudioLayout.Placement, strength: Double, canvas: CGSize) -> CIImage {
        let rect = Self.flip(placement.frame, in: canvas)
        let short = min(canvas.width, canvas.height)
        let radius: Double = switch placement.shape {
        case let .rounded(radius): radius
        case .circle: min(rect.width, rect.height) / 2
        }
        let generator = CIFilter.roundedRectangleGenerator()
        generator.extent = rect.offsetBy(dx: 0, dy: -short * 0.012 * strength)
        generator.radius = Float(radius)
        generator.color = CIColor(red: 0, green: 0, blue: 0, alpha: 0.55 * strength)
        let blur = short * 0.035 * (0.4 + strength)
        return (generator.outputImage ?? CIImage.empty()).applyingGaussianBlur(sigma: blur).cropped(to: CGRect(origin: .zero, size: canvas))
    }

    private func background(_ background: StudioBackground, image: CGImage?, size: CGSize) -> CIImage {
        let canvas = CGRect(origin: .zero, size: size)
        switch background {
        case .none:
            return CIImage(color: .black).cropped(to: canvas)
        case let .color(color):
            let c = color.components
            return CIImage(color: CIColor(red: c.red, green: c.green, blue: c.blue)).cropped(to: canvas)
        case let .gradient(from, to, angle):
            // The angle runs like CSS: 90 is left to right, 180 top to bottom.
            let radians = (angle - 90) * .pi / 180
            let half = (abs(cos(radians)) * size.width + abs(sin(radians)) * size.height) / 2
            let centre = CGPoint(x: size.width / 2, y: size.height / 2)
            let dx = cos(radians) * half
            let dy = -sin(radians) * half
            let gradient = CIFilter.linearGradient()
            gradient.point0 = CGPoint(x: centre.x - dx, y: centre.y - dy)
            gradient.point1 = CGPoint(x: centre.x + dx, y: centre.y + dy)
            let a = from.components
            let b = to.components
            gradient.color0 = CIColor(red: a.red, green: a.green, blue: a.blue)
            gradient.color1 = CIColor(red: b.red, green: b.green, blue: b.blue)
            return (gradient.outputImage ?? CIImage(color: .black)).cropped(to: canvas)
        case .wallpaper, .image:
            guard let image else { return CIImage(color: CIColor(red: 0.1, green: 0.1, blue: 0.12)).cropped(to: canvas) }
            let picture = CIImage(cgImage: image)
            let fill = StudioLayout.fill(picture.extent.size, into: canvas)
            return picture
                .transformed(by: CGAffineTransform(scaleX: fill.scale, y: fill.scale).concatenating(CGAffineTransform(translationX: fill.origin.x, y: fill.origin.y)))
                .cropped(to: canvas)
        }
    }

    /// Layout is top-left; Core Image is bottom-left.
    static func flip(_ rect: CGRect, in canvas: CGSize) -> CGRect {
        CGRect(x: rect.minX, y: canvas.height - rect.maxY, width: rect.width, height: rect.height)
    }

    // MARK: Buffers

    nonisolated(unsafe) static let bufferAttributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
        kCVPixelBufferMetalCompatibilityKey as String: true,
    ]

    private func makeBuffer(size: CGSize) -> CVPixelBuffer? {
        poolLock.lock()
        if poolSize != size || pool == nil {
            var attributes = Self.bufferAttributes
            attributes[kCVPixelBufferWidthKey as String] = Int(size.width)
            attributes[kCVPixelBufferHeightKey as String] = Int(size.height)
            var created: CVPixelBufferPool?
            CVPixelBufferPoolCreate(kCFAllocatorDefault, [kCVPixelBufferPoolMinimumBufferCountKey: 3] as CFDictionary, attributes as CFDictionary, &created)
            pool = created
            poolSize = size
        }
        let current = pool
        poolLock.unlock()
        guard let current else { return nil }
        var buffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, current, &buffer)
        return buffer
    }

    private func makeStaticBuffer(size: CGSize) -> CVPixelBuffer? {
        var attributes = Self.bufferAttributes
        attributes[kCVPixelBufferWidthKey as String] = Int(size.width)
        attributes[kCVPixelBufferHeightKey as String] = Int(size.height)
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, Int(size.width), Int(size.height), kCVPixelFormatType_32BGRA, attributes as CFDictionary, &buffer)
        return buffer
    }
}

// MARK: - Compositor

/// Carries the scene to the compositor. AVFoundation creates compositors itself, so this is the only way in.
public final class StudioInstruction: NSObject, AVVideoCompositionInstructionProtocol, @unchecked Sendable {
    public let timeRange: CMTimeRange
    public let enablePostProcessing = false
    public let containsTweening = true
    public let requiredSourceTrackIDs: [NSValue]?
    public let passthroughTrackID = kCMPersistentTrackID_Invalid
    public let scene: StudioScene
    public let screenTrack: CMPersistentTrackID?
    public let cameraTrack: CMPersistentTrackID?
    /// The preview keeps its last frames for paused redraws; an export doesn't need to.
    public let remembersFrames: Bool

    public init(timeRange: CMTimeRange, scene: StudioScene, screenTrack: CMPersistentTrackID?, cameraTrack: CMPersistentTrackID?, remembersFrames: Bool) {
        self.timeRange = timeRange
        self.scene = scene
        self.screenTrack = screenTrack
        self.cameraTrack = cameraTrack
        self.remembersFrames = remembersFrames
        requiredSourceTrackIDs = [screenTrack, cameraTrack].compactMap { $0 }.map { NSNumber(value: $0) }
    }
}

public final class StudioCompositor: NSObject, AVVideoCompositing, @unchecked Sendable {

    /// Milliseconds spent rendering each frame, for the editor's measurements.
    static let renderTimes = Mutex<[Double]>([])

    /// The frame times recorded since the last call.
    public static func takeRenderTimes() -> [Double] {
        renderTimes.withLock { times in
            defer { times.removeAll() }
            return times
        }
    }

    public var sourcePixelBufferAttributes: [String: any Sendable]? {
        [
            kCVPixelBufferPixelFormatTypeKey as String: [kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, kCVPixelFormatType_32BGRA],
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: String](),
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ]
    }

    public var requiredPixelBufferAttributesForRenderContext: [String: any Sendable] {
        [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: String](),
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ]
    }

    public func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}

    /// Up to three frames render at once, so decoding, compositing and encoding overlap. AVFoundation asks for frames
    /// as fast as it can during an export; past three it waits here, which keeps memory to a few frames.
    private static let slots = 3
    private let inFlight = DispatchSemaphore(value: StudioCompositor.slots)
    private let queue = DispatchQueue(label: "so.cap.mobile.studio.compositor", qos: .userInteractive, attributes: .concurrent)

    public func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        inFlight.wait()
        queue.async { [self] in
            defer { inFlight.signal() }
            guard let instruction = request.videoCompositionInstruction as? StudioInstruction,
                  let output = request.renderContext.newPixelBuffer()
            else {
                request.finish(with: NSError(domain: "so.cap.mobile.studio", code: 1))
                return
            }
            let started = CACurrentMediaTime()
            let screen = instruction.screenTrack.flatMap { request.sourceFrame(byTrackID: $0) }
            let camera = instruction.cameraTrack.flatMap { request.sourceFrame(byTrackID: $0) }
            let scene = instruction.scene
            scene.renderer.render(scene: scene, screen: screen, camera: camera, into: output)
            if instruction.remembersFrames {
                let size = CGSize(width: CVPixelBufferGetWidth(output), height: CVPixelBufferGetHeight(output))
                scene.remember(.init(time: request.compositionTime, screen: screen, camera: camera, size: size))
            }
            let took = (CACurrentMediaTime() - started) * 1000
            Self.renderTimes.withLock { times in
                times.append(took)
                if times.count > 2000 { times.removeFirst(times.count - 2000) }
            }
            request.finish(withComposedVideoFrame: output)
        }
    }

    /// Requests already started finish; at most three, so there is little to gain from dropping them.
    public func cancelAllPendingVideoCompositionRequests() {}
}

// MARK: - Composition

/// A source on the timeline: one video track (and its sound) starting `offset` seconds into the project.
public struct StudioTrackSource: @unchecked Sendable {
    public let asset: AVAsset
    public let video: AVAssetTrack
    public let audio: AVAssetTrack?
    public let duration: Double
    public let offset: Double
    public let info: StudioSourceInfo
    /// Stretches of the track's own time with no pictures, which show as nothing rather than a frozen frame.
    public let gaps: [EditRange]

    public init(asset: AVAsset, video: AVAssetTrack, audio: AVAssetTrack?, duration: Double, offset: Double, info: StudioSourceInfo, gaps: [EditRange] = []) {
        self.asset = asset
        self.video = video
        self.audio = audio
        self.duration = duration
        self.offset = offset
        self.info = info
        self.gaps = gaps
    }

    public static func load(url: URL, offset: Double, gaps: [EditRange] = [], precise: Bool = true) async throws -> StudioTrackSource {
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: precise])
        let source = try await load(asset: asset, offset: offset)
        return StudioTrackSource(asset: source.asset, video: source.video, audio: source.audio, duration: source.duration, offset: source.offset, info: source.info, gaps: gaps)
    }

    /// Where the track has pictures, in its own time.
    var pictured: [EditRange] {
        StudioProject.Track(file: "", offset: offset, duration: duration, gaps: gaps).recorded
    }

    public static func load(asset: AVAsset, offset: Double) async throws -> StudioTrackSource {
        async let videos = asset.loadTracks(withMediaType: .video)
        async let audios = asset.loadTracks(withMediaType: .audio)
        async let length = asset.load(.duration)
        guard let video = try await videos.first else { throw StudioComposition.Failure.noVideo }
        let audio = try await audios.first
        let duration = try await length.seconds
        async let size = video.load(.naturalSize)
        async let transform = video.load(.preferredTransform)
        let info = StudioSourceInfo(naturalSize: try await size, transform: (try? await transform) ?? .identity)
        return StudioTrackSource(asset: asset, video: video, audio: audio, duration: duration, offset: offset, info: info)
    }
}

public struct StudioMusicSource: @unchecked Sendable {
    /// Held because a track only weakly references its asset; without it inserts fail with -12780.
    public let asset: AVAsset
    public let track: AVAssetTrack
    public let duration: Double
    public let volume: Double
    public let offset: Double

    public init(asset: AVAsset, track: AVAssetTrack, duration: Double, volume: Double, offset: Double) {
        self.asset = asset
        self.track = track
        self.duration = duration
        self.volume = volume
        self.offset = offset
    }

    public static func load(url: URL, volume: Double, offset: Double) async throws -> StudioMusicSource {
        let asset = AVURLAsset(url: url)
        async let tracks = asset.loadTracks(withMediaType: .audio)
        async let length = asset.load(.duration)
        guard let track = try await tracks.first else { throw StudioComposition.Failure.noAudio }
        return StudioMusicSource(asset: asset, track: track, duration: try await length.seconds, volume: volume, offset: offset)
    }
}

/// Builds the edited video as an `AVComposition`: only references to the recorded files, so a rebuild takes
/// milliseconds and nothing is encoded until export.
public struct StudioComposition: @unchecked Sendable {
    public enum Failure: Error { case noVideo, noAudio }

    public static let screenTrackID: CMPersistentTrackID = 1
    public static let cameraTrackID: CMPersistentTrackID = 2

    public let composition: AVMutableComposition
    public let videoComposition: AVVideoComposition?
    public let audioMix: AVAudioMix?
    public let renderSize: CGSize
    public let duration: Double

    /// `clips` are ranges of project time to keep, in order. `screen` is the main video: a screen recording, or the
    /// Cap being edited.
    public static func build(
        clips: [EditRange],
        screen: StudioTrackSource?,
        camera: StudioTrackSource?,
        music: StudioMusicSource?,
        voiceVolume: Double,
        scene: StudioScene,
        longEdge: Double,
        frameRate: Int32 = 30,
        remembersFrames: Bool,
        passthrough: Bool = false
    ) throws -> StudioComposition {
        let composition = AVMutableComposition()
        let screenVideo = screen.flatMap { _ in composition.addMutableTrack(withMediaType: .video, preferredTrackID: screenTrackID) }
        let cameraVideo = camera.flatMap { _ in composition.addMutableTrack(withMediaType: .video, preferredTrackID: cameraTrackID) }
        let screenAudio = screen?.audio.flatMap { _ in composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) }
        let cameraAudio = camera?.audio.flatMap { _ in composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) }

        var cursor = CMTime.zero
        for clip in clips {
            let start = CMTime(seconds: clip.start, preferredTimescale: 600)
            let end = CMTime(seconds: clip.end, preferredTimescale: 600)
            guard end > start else { continue }
            if let screen, let screenVideo { try insert(screen, video: screenVideo, audio: screenAudio, from: start, to: end, at: cursor) }
            if let camera, let cameraVideo { try insert(camera, video: cameraVideo, audio: cameraAudio, from: start, to: end, at: cursor) }
            cursor = cursor + CMTimeSubtract(end, start)
        }
        let total = cursor
        guard total > .zero, screenVideo != nil || cameraVideo != nil else { throw Failure.noVideo }

        var mixes: [AVMutableAudioMixInputParameters] = []
        for track in [screenAudio, cameraAudio].compactMap({ $0 }) where voiceVolume != 1 {
            let parameters = AVMutableAudioMixInputParameters(track: track)
            parameters.setVolume(Float(voiceVolume), at: .zero)
            mixes.append(parameters)
        }
        if let music, music.duration > 0.5, let musicTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
            // Loops to cover the whole video, starting `offset` into the song.
            var at = CMTime.zero
            var from = CMTime(seconds: min(max(0, music.offset), music.duration - 0.5), preferredTimescale: 600)
            let songEnd = CMTime(seconds: music.duration, preferredTimescale: 600)
            while at < total {
                let length = CMTimeMinimum(CMTimeSubtract(songEnd, from), CMTimeSubtract(total, at))
                guard length > .zero else { break }
                try musicTrack.insertTimeRange(CMTimeRange(start: from, duration: length), of: music.track, at: at)
                at = at + length
                from = .zero
            }
            let parameters = AVMutableAudioMixInputParameters(track: musicTrack)
            let fade = CMTime(seconds: min(StudioMusic.fadeOut, total.seconds / 3), preferredTimescale: 600)
            parameters.setVolume(Float(music.volume), at: .zero)
            parameters.setVolumeRamp(fromStartVolume: Float(music.volume), toEndVolume: 0, timeRange: CMTimeRange(start: CMTimeSubtract(total, fade), duration: fade))
            mixes.append(parameters)
        }
        let audioMix: AVMutableAudioMix? = mixes.isEmpty ? nil : {
            let mix = AVMutableAudioMix()
            mix.inputParameters = mixes
            return mix
        }()

        let state = scene.current.state
        // An untouched video with nothing over it plays straight from the decoder, with no compositing at all.
        if passthrough, cameraVideo == nil, let screen, let screenVideo {
            screenVideo.preferredTransform = screen.info.transform
            return StudioComposition(composition: composition, videoComposition: nil, audioMix: audioMix, renderSize: screen.info.displaySize, duration: total.seconds)
        }
        let renderSize = StudioLayout.canvasSize(look: state.look, primary: state.screen?.displaySize, camera: state.camera?.displaySize, longEdge: longEdge)
        let instruction = StudioInstruction(
            timeRange: CMTimeRange(start: .zero, duration: total),
            scene: scene,
            screenTrack: screenVideo.map { _ in screenTrackID },
            cameraTrack: cameraVideo.map { _ in cameraTrackID },
            remembersFrames: remembersFrames
        )
        let videoComposition: AVVideoComposition
        if #available(iOS 26, macOS 26, *) {
            var configuration = AVVideoComposition.Configuration()
            configuration.customVideoCompositorClass = StudioCompositor.self
            configuration.frameDuration = CMTime(value: 1, timescale: frameRate)
            configuration.renderSize = renderSize
            configuration.instructions = [instruction]
            videoComposition = AVVideoComposition(configuration: configuration)
        } else {
            let mutable = AVMutableVideoComposition()
            mutable.customVideoCompositorClass = StudioCompositor.self
            mutable.frameDuration = CMTime(value: 1, timescale: frameRate)
            mutable.renderSize = renderSize
            mutable.instructions = [instruction]
            videoComposition = mutable
        }
        return StudioComposition(composition: composition, videoComposition: videoComposition, audioMix: audioMix, renderSize: renderSize, duration: total.seconds)
    }

    /// Inserts the part of a source that overlaps project time `start..<end`, leaving a gap where it wasn't recording.
    private static func insert(_ source: StudioTrackSource, video: AVMutableCompositionTrack, audio: AVMutableCompositionTrack?, from start: CMTime, to end: CMTime, at cursor: CMTime) throws {
        let offset = CMTime(seconds: source.offset, preferredTimescale: 600)
        let sourceEnd = CMTime(seconds: source.offset + source.duration, preferredTimescale: 600)
        let overlapStart = CMTimeMaximum(start, offset)
        let overlapEnd = CMTimeMinimum(end, sourceEnd)
        guard overlapEnd > overlapStart else { return }
        let range = CMTimeRange(start: CMTimeSubtract(overlapStart, offset), end: CMTimeSubtract(overlapEnd, offset))
        let at = cursor + CMTimeSubtract(overlapStart, start)
        // Pictures only where the track recorded some: across a gap the slot is left empty, so the compositor gets no
        // frame and draws nothing there instead of holding the last one.
        for piece in source.pictured {
            let pieceRange = CMTimeRange(start: CMTime(seconds: piece.start, preferredTimescale: 600), end: CMTime(seconds: piece.end, preferredTimescale: 600))
            let clipped = range.intersection(pieceRange)
            guard clipped.duration > .zero else { continue }
            try video.insertTimeRange(clipped, of: source.video, at: at + CMTimeSubtract(clipped.start, range.start))
        }
        // Sound runs straight through: silence in a gap is real silence, and the voice must never shift.
        if let audio, let track = source.audio {
            try? audio.insertTimeRange(range, of: track, at: at)
        }
    }
}
