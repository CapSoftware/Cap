import CoreGraphics
import Foundation

public struct StudioColor: Codable, Sendable, Hashable {
    public var red: UInt8
    public var green: UInt8
    public var blue: UInt8

    public init(_ red: UInt8, _ green: UInt8, _ blue: UInt8) {
        self.red = red
        self.green = green
        self.blue = blue
    }

    public var components: (red: Double, green: Double, blue: Double) {
        (Double(red) / 255, Double(green) / 255, Double(blue) / 255)
    }
}

public enum StudioBackground: Codable, Sendable, Hashable {
    case none
    case color(StudioColor)
    case gradient(from: StudioColor, to: StudioColor, angle: Double)
    case wallpaper(String)
    case image(String)

    public var isNone: Bool { self == .none }

    /// Cap desktop's gradient presets, in the same order.
    public static let gradients: [StudioBackground] = [
        (StudioColor(71, 133, 255), StudioColor(255, 71, 102)),
        (StudioColor(15, 52, 67), StudioColor(52, 232, 158)),
        (StudioColor(34, 193, 195), StudioColor(253, 187, 45)),
        (StudioColor(29, 253, 251), StudioColor(195, 29, 253)),
        (StudioColor(69, 104, 220), StudioColor(176, 106, 179)),
        (StudioColor(106, 130, 251), StudioColor(252, 92, 125)),
        (StudioColor(131, 58, 180), StudioColor(253, 29, 29)),
        (StudioColor(249, 212, 35), StudioColor(255, 78, 80)),
        (StudioColor(255, 94, 0), StudioColor(255, 42, 104)),
        (StudioColor(255, 0, 150), StudioColor(0, 204, 255)),
        (StudioColor(0, 242, 96), StudioColor(5, 117, 230)),
        (StudioColor(238, 205, 163), StudioColor(239, 98, 159)),
        (StudioColor(44, 62, 80), StudioColor(52, 152, 219)),
        (StudioColor(168, 239, 255), StudioColor(238, 205, 163)),
        (StudioColor(74, 0, 224), StudioColor(143, 0, 255)),
        (StudioColor(252, 74, 26), StudioColor(247, 183, 51)),
    ].map { .gradient(from: $0.0, to: $0.1, angle: 135) }

    public static let colors: [StudioBackground] = [
        StudioColor(255, 255, 255), StudioColor(0, 0, 0), StudioColor(28, 28, 30), StudioColor(242, 242, 247),
        StudioColor(71, 133, 255), StudioColor(255, 69, 0), StudioColor(255, 140, 0), StudioColor(255, 215, 0),
        StudioColor(50, 205, 50), StudioColor(0, 206, 209), StudioColor(75, 0, 130), StudioColor(128, 0, 128),
    ].map { .color($0) }
}

public enum StudioAspect: String, Codable, Sendable, CaseIterable, Identifiable {
    case auto
    case portrait
    case fourFive
    case square
    case landscape

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .auto: "Original"
        case .portrait: "9:16"
        case .fourFive: "4:5"
        case .square: "1:1"
        case .landscape: "16:9"
        }
    }

    /// Width over height, or nil to follow the recording.
    public var ratio: Double? {
        switch self {
        case .auto: nil
        case .portrait: 9.0 / 16
        case .fourFive: 4.0 / 5
        case .square: 1
        case .landscape: 16.0 / 9
        }
    }
}

public enum StudioCorner: String, Codable, Sendable, CaseIterable {
    case topLeading
    case topTrailing
    case bottomLeading
    case bottomTrailing
}

public enum StudioCameraShape: String, Codable, Sendable, CaseIterable, Identifiable {
    case circle
    case rounded
    case square

    public var id: String { rawValue }
}

public enum StudioCameraLayout: String, Codable, Sendable, CaseIterable, Identifiable {
    case bubble
    /// Screen above the camera (side by side when the frame is wide).
    case split
    case cameraOnly
    case screenOnly

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .bubble: "Bubble"
        case .split: "Split"
        case .cameraOnly: "Camera"
        case .screenOnly: "Screen"
        }
    }
}

public struct StudioCameraLook: Codable, Sendable, Hashable {
    public var layout: StudioCameraLayout = .bubble
    public var corner: StudioCorner = .bottomTrailing
    /// Diameter as a share of the frame's shorter side.
    public var size: Double = 0.32
    public var shape: StudioCameraShape = .circle

    public init() {}

    public static let sizeRange: ClosedRange<Double> = 0.18...0.6
}

public struct StudioLook: Codable, Sendable, Hashable {
    public var background: StudioBackground
    /// Space around the video as a share of the frame's shorter side.
    public var padding: Double
    /// As a share of the video's shorter side.
    public var rounding: Double
    public var shadow: Double
    public var aspect: StudioAspect
    public var camera: StudioCameraLook

    public init(background: StudioBackground = .none, padding: Double = 0, rounding: Double = 0, shadow: Double = 0, aspect: StudioAspect = .auto, camera: StudioCameraLook = .init()) {
        self.background = background
        self.padding = padding
        self.rounding = rounding
        self.shadow = shadow
        self.aspect = aspect
        self.camera = camera
    }

    public static let untouched = StudioLook()
    /// What a new Studio recording starts with.
    public static let studioDefault = StudioLook(background: StudioBackground.gradients[0], padding: 0.06, rounding: 0.06, shadow: 0.6)

    public static let paddingRange: ClosedRange<Double> = 0...0.2
    public static let roundingRange: ClosedRange<Double> = 0...0.2

    /// True when rendering can't change a single pixel of the main video.
    public func isIdentity(hasCamera: Bool) -> Bool {
        background.isNone && aspect == .auto && padding == 0 && rounding == 0 && (!hasCamera || camera.layout == .screenOnly)
    }

    /// Without a background the frame is the video itself, so padding, corners and shadow have nothing to show on.
    public var effectivePadding: Double { background.isNone ? 0 : padding }
    public var effectiveRounding: Double { background.isNone ? 0 : rounding }
    public var effectiveShadow: Double { background.isNone ? 0 : shadow }
}

public struct StudioMusic: Codable, Sendable, Hashable {
    public enum Source: Codable, Sendable, Hashable {
        case builtIn(String)
        case file(String)
    }

    public var source: Source
    public var title: String
    public var volume: Double
    /// Seconds into the track where the video starts.
    public var offset: Double

    public init(source: Source, title: String, volume: Double = 0.35, offset: Double = 0) {
        self.source = source
        self.title = title
        self.volume = volume
        self.offset = offset
    }

    public static let fadeOut: Double = 1.5
}

/// One recording made in Studio Mode. It stays on the phone until it's shared, so it can be edited with nothing
/// re-encoded and nothing uploaded twice.
public struct StudioProject: Codable, Sendable, Hashable, Identifiable {
    public struct Track: Codable, Sendable, Hashable {
        public var file: String
        /// Seconds from the project's start to the track's first frame. Screen and camera are recorded by different
        /// processes, so each starts when its own first frame arrives.
        public var offset: Double
        public var duration: Double
        /// Seconds from the track's first frame where it recorded nothing. Hidden rather than frozen.
        public var gaps: [EditRange]?
        /// Sound recorded beside the picture, in its own file.
        public var audio: Audio?

        public struct Audio: Codable, Sendable, Hashable {
            public var file: String
            /// Seconds from the track's first frame to its first sound; negative when the sound started first.
            public var offset: Double
            public var duration: Double

            public init(file: String, offset: Double, duration: Double) {
                self.file = file
                self.offset = offset
                self.duration = duration
            }
        }

        public init(file: String, offset: Double, duration: Double, gaps: [EditRange]? = nil, audio: Audio? = nil) {
            self.file = file
            self.offset = offset
            self.duration = duration
            self.gaps = gaps
            self.audio = audio
        }

        public var recorded: [EditRange] {
            var ranges: [EditRange] = []
            var cursor = 0.0
            for gap in (gaps ?? []).sorted(by: { $0.start < $1.start }) where gap.end > cursor {
                if gap.start > cursor { ranges.append(EditRange(start: cursor, end: min(gap.start, duration))) }
                cursor = max(cursor, gap.end)
            }
            if duration > cursor { ranges.append(EditRange(start: cursor, end: duration)) }
            return ranges.filter { $0.duration > 0.001 }
        }
    }

    public var id: String
    public var title: String
    public var createdAt: Date
    public var screen: Track?
    public var camera: Track?
    public var look: StudioLook
    public var music: StudioMusic?
    public var voiceVolume: Double
    /// Kept ranges in project time, the same model the Cap editor uses.
    public var clips: [EditRange]?
    public var capId: String?

    public init(id: String = UUID().uuidString.lowercased(), title: String, createdAt: Date = .now, screen: Track? = nil, camera: Track? = nil, look: StudioLook = .studioDefault, music: StudioMusic? = nil, voiceVolume: Double = 1, clips: [EditRange]? = nil, capId: String? = nil) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.screen = screen
        self.camera = camera
        self.look = look
        self.music = music
        self.voiceVolume = voiceVolume
        self.clips = clips
        self.capId = capId
    }

    public var duration: Double {
        max(screen.map { $0.offset + $0.duration } ?? 0, camera.map { $0.offset + $0.duration } ?? 0)
    }

    public var isEmpty: Bool { screen == nil && camera == nil }

    public var timeline: EditTimeline {
        if let clips { EditTimeline(sourceDuration: duration, clips: clips) } else { EditTimeline(sourceDuration: duration) }
    }
}

/// Where each piece of a frame goes, in pixels with the origin at the top left. Shared by the preview, the export and
/// the tests, so the three can't disagree.
public struct StudioLayout: Sendable, Equatable {
    public enum Shape: Sendable, Equatable {
        case rounded(radius: Double)
        case circle
    }

    public struct Placement: Sendable, Equatable {
        /// Where the visible part goes.
        public var frame: CGRect
        public var shape: Shape
    }

    public let canvas: CGSize
    public let screen: Placement?
    public let camera: Placement?

    /// The longest edge of an exported video. 1080p on the long side keeps phone recordings sharp at a sensible size.
    public static let exportLongEdge: Double = 1920
    /// Small enough to composite fast while the editor plays, larger than any phone shows it.
    public static let previewLongEdge: Double = 1280

    /// The frame size for a look. `primary` is the shape of the screen (or the Cap's video), `camera` of the camera.
    public static func canvasSize(look: StudioLook, primary: CGSize?, camera: CGSize?, longEdge: Double) -> CGSize {
        let content = contentShape(look: look, primary: primary, camera: camera)
        let natural: Double = content.height > 0 ? Double(content.width / content.height) : 9.0 / 16
        let ratio: Double = look.aspect.ratio ?? natural
        // Never upscale the recording: a 720p video exports at 720p.
        let sourceLong = Double(max(content.width, content.height))
        let long: Double = sourceLong > 0 ? min(longEdge, max(sourceLong, longEdge / 2)) : longEdge
        var width: Double = ratio >= 1 ? long : long * ratio
        var height: Double = ratio >= 1 ? long / ratio : long
        // H.264 wants even sizes.
        width = (width / 2).rounded() * 2
        height = (height / 2).rounded() * 2
        return CGSize(width: max(2, width), height: max(2, height))
    }

    private static func contentShape(look: StudioLook, primary: CGSize?, camera: CGSize?) -> CGSize {
        switch look.camera.layout {
        case .cameraOnly: camera ?? primary ?? .zero
        case .split where primary != nil && camera != nil:
            // Stacked, so the frame is as wide as the screen and twice as tall as half of it.
            primary.map { CGSize(width: $0.width, height: $0.height) } ?? .zero
        default: primary ?? camera ?? .zero
        }
    }

    public init(look: StudioLook, canvas: CGSize, primary: CGSize?, camera: CGSize?) {
        self.canvas = canvas
        let short: CGFloat = min(canvas.width, canvas.height)
        let inset: CGFloat = CGFloat(look.effectivePadding) * short
        let area = CGRect(origin: .zero, size: canvas).insetBy(dx: inset, dy: inset)
        let roundingShare = CGFloat(look.effectiveRounding)

        func rounded(_ rect: CGRect) -> Shape {
            .rounded(radius: Double(roundingShare * min(rect.width, rect.height)))
        }

        var layout = look.camera.layout
        if camera == nil { layout = .screenOnly }
        if primary == nil { layout = .cameraOnly }

        switch layout {
        case .screenOnly:
            let frame = primary.map { Self.fit($0, in: area) } ?? .zero
            screen = Placement(frame: frame, shape: rounded(frame))
            self.camera = nil
        case .cameraOnly:
            // Camera fills the space: a face is better cropped than letterboxed.
            screen = nil
            self.camera = Placement(frame: area, shape: rounded(area))
        case .split:
            let gap: CGFloat = max(inset / 2, short * 0.015)
            let wide = canvas.width > canvas.height
            let first: CGRect
            let second: CGRect
            if wide {
                let width: CGFloat = (area.width - gap) / 2
                first = CGRect(x: area.minX, y: area.minY, width: width, height: area.height)
                second = CGRect(x: area.minX + width + gap, y: area.minY, width: width, height: area.height)
            } else {
                // The screen keeps its shape; the camera takes what's left, but never less than a third.
                let topHeight: CGFloat = area.height * 2 / 3 - gap / 2
                let screenFit = primary.map { Self.fit($0, in: CGRect(x: area.minX, y: area.minY, width: area.width, height: topHeight)) } ?? .zero
                let screenHeight: CGFloat = max(screenFit.height, 1)
                first = CGRect(x: area.minX, y: area.minY, width: area.width, height: screenHeight)
                second = CGRect(x: area.minX, y: area.minY + screenHeight + gap, width: area.width, height: max(1, area.height - screenHeight - gap))
            }
            let screenFrame = primary.map { Self.fit($0, in: first) } ?? first
            screen = Placement(frame: screenFrame, shape: rounded(screenFrame))
            // A split always has some rounding on the camera, or the two halves read as one video.
            let cameraShape = Shape.rounded(radius: Double(max(roundingShare, 0.04) * min(second.width, second.height)))
            self.camera = Placement(frame: second, shape: cameraShape)
        case .bubble:
            let frame = primary.map { Self.fit($0, in: area) } ?? .zero
            screen = Placement(frame: frame, shape: rounded(frame))
            let side: CGFloat = CGFloat(min(max(look.camera.size, StudioCameraLook.sizeRange.lowerBound), StudioCameraLook.sizeRange.upperBound)) * short
            let margin: CGFloat = max(short * 0.035, inset * 0.6)
            // Over the frame, inside the padding when there is some, so the bubble sits on the video's corner.
            let bounds = look.effectivePadding > 0 ? frame.insetBy(dx: -inset * 0.4, dy: -inset * 0.4) : CGRect(origin: .zero, size: canvas)
            let x: CGFloat
            let y: CGFloat
            switch look.camera.corner {
            case .topLeading, .bottomLeading: x = bounds.minX + margin
            case .topTrailing, .bottomTrailing: x = bounds.maxX - margin - side
            }
            switch look.camera.corner {
            case .topLeading, .topTrailing: y = bounds.minY + margin
            case .bottomLeading, .bottomTrailing: y = bounds.maxY - margin - side
            }
            let bubble = CGRect(x: min(max(0, x), canvas.width - side), y: min(max(0, y), canvas.height - side), width: side, height: side)
            let shape: Shape = switch look.camera.shape {
            case .circle: .circle
            case .rounded: .rounded(radius: Double(side * 0.22))
            case .square: .rounded(radius: Double(side * 0.04))
            }
            self.camera = Placement(frame: bubble, shape: shape)
        }
    }

    public static func fit(_ size: CGSize, in area: CGRect) -> CGRect {
        guard size.width > 0, size.height > 0, area.width > 0, area.height > 0 else { return area }
        let scale = min(area.width / size.width, area.height / size.height)
        let width = (size.width * scale).rounded()
        let height = (size.height * scale).rounded()
        return CGRect(x: (area.midX - width / 2).rounded(), y: (area.midY - height / 2).rounded(), width: width, height: height)
    }

    public static func fill(_ size: CGSize, into rect: CGRect) -> (scale: Double, origin: CGPoint) {
        guard size.width > 0, size.height > 0 else { return (1, rect.origin) }
        let scale = max(rect.width / size.width, rect.height / size.height)
        let origin = CGPoint(x: rect.midX - size.width * scale / 2, y: rect.midY - size.height * scale / 2)
        return (scale, origin)
    }

    public static func nearestCorner(to point: CGPoint, in canvas: CGSize) -> StudioCorner {
        let left = point.x < canvas.width / 2
        let top = point.y < canvas.height / 2
        switch (top, left) {
        case (true, true): return .topLeading
        case (true, false): return .topTrailing
        case (false, true): return .bottomLeading
        case (false, false): return .bottomTrailing
        }
    }
}

/// Studio projects live in the app group, so the screen recording extension can write into them.
public final class StudioStore: @unchecked Sendable {
    public let root: URL
    private let lock = NSLock()

    public init(root: URL) {
        self.root = root
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = root
        try? url.setResourceValues(values)
    }

    private static func base(appGroup: String) -> URL {
        let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return container.appending(path: "Studio", directoryHint: .isDirectory)
    }

    /// One user's drafts. Each account has its own folder, so signing in as someone else never shows them.
    public static func shared(owner: String, appGroup: String = "group.so.cap.mobile") -> StudioStore {
        StudioStore(root: base(appGroup: appGroup).appending(path: "Users/\(folderName(for: owner))", directoryHint: .isDirectory))
    }

    /// Where the app leaves requests for the screen recording extension, outside every user's drafts.
    public static func requests(appGroup: String = "group.so.cap.mobile") -> StudioStore {
        StudioStore(root: base(appGroup: appGroup))
    }

    /// User ids are server data; only plain characters reach the file system.
    static func folderName(for owner: String) -> String {
        let allowed = owner.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "_" || $0 == "-" }
        let name = String(String.UnicodeScalarView(allowed)).prefix(80)
        return name.isEmpty ? "unknown" : String(name)
    }

    public func directory(for id: String) -> URL {
        root.appending(path: id, directoryHint: .isDirectory)
    }

    public func url(_ file: String, in id: String) -> URL {
        directory(for: id).appending(path: file)
    }

    private func manifest(for id: String) -> URL {
        directory(for: id).appending(path: "project.json")
    }

    public func save(_ project: StudioProject) throws {
        lock.lock()
        defer { lock.unlock() }
        try FileManager.default.createDirectory(at: directory(for: project.id), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(project).write(to: manifest(for: project.id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func load(_ id: String) -> StudioProject? {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? Data(contentsOf: manifest(for: id)) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(StudioProject.self, from: data)
    }

    /// Newest first. Skips folders without a readable manifest, such as a recording still being written.
    public func all() -> [StudioProject] {
        let ids = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        return ids.compactMap(load).filter { !$0.isEmpty }.sorted { $0.createdAt > $1.createdAt }
    }

    public func delete(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        try? FileManager.default.removeItem(at: directory(for: id))
    }

    /// Studio files are large: an hour of screen is a few gigabytes.
    public func hasRoomToRecord(minimum: Int64 = 1_000_000_000) -> Bool {
        #if os(iOS)
        let free = (try? root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage) ?? Int64.max
        #else
        let free = Int64((try? root.resourceValues(forKeys: [.volumeAvailableCapacityKey]).volumeAvailableCapacity) ?? Int.max)
        #endif
        return free >= minimum
    }

    public func size(of id: String) -> Int64 {
        let directory = directory(for: id)
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return files.reduce(0) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
    }
}

/// The app asks the screen recording extension to record into a Studio project rather than upload. Written by the
/// app just before the system sheet opens, taken once by the extension.
public enum StudioScreenRequest {
    public struct Request: Codable, Sendable, Equatable {
        public var projectId: String
        /// Whose drafts the recording joins.
        public var ownerId: String
        public var requestedAt: Date

        public init(projectId: String, ownerId: String, requestedAt: Date = .now) {
            self.projectId = projectId
            self.ownerId = ownerId
            self.requestedAt = requestedAt
        }
    }

    /// A request older than this is from a sheet that was closed without recording.
    public static let lifetime: TimeInterval = 10 * 60
    public static let finishedNotification = "so.cap.mobile.studio.screen-finished"

    private static func file(in store: StudioStore) -> URL {
        store.root.appending(path: "screen-request.json")
    }

    public static func set(_ request: Request?, in store: StudioStore) {
        let url = file(in: store)
        guard let request, let data = try? JSONEncoder().encode(request) else {
            try? FileManager.default.removeItem(at: url)
            return
        }
        try? data.write(to: url, options: .atomic)
    }

    public static func peek(in store: StudioStore, now: Date = .now) -> Request? {
        guard let data = try? Data(contentsOf: file(in: store)),
              let request = try? JSONDecoder().decode(Request.self, from: data),
              now.timeIntervalSince(request.requestedAt) < lifetime, now >= request.requestedAt.addingTimeInterval(-60)
        else { return nil }
        return request
    }

    /// Returns the request at most once.
    public static func take(in store: StudioStore, now: Date = .now) -> Request? {
        let request = peek(in: store, now: now)
        set(nil, in: store)
        return request
    }
}
