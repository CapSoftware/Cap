import Foundation

/// A named look: background, frame and camera layout, applied in one tap.
public struct StudioPreset: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var look: StudioLook

    public init(id: String = UUID().uuidString.lowercased(), name: String, look: StudioLook) {
        self.id = id
        self.name = name
        self.look = look
    }

    /// Cap's own presets can be used and made the default, but not changed or deleted.
    public var isBuiltIn: Bool { id.hasPrefix(Self.builtInPrefix) }

    static let builtInPrefix = "cap."

    private static func look(_ background: StudioBackground, aspect: StudioAspect = .auto, padding: Double = 0.08, rounding: Double = 0.07, shadow: Double = 0.7, layout: StudioCameraLayout = .bubble, corner: StudioCorner = .bottomTrailing, size: Double = 0.32, shape: StudioCameraShape = .circle) -> StudioLook {
        var camera = StudioCameraLook()
        camera.layout = layout
        camera.corner = corner
        camera.size = size
        camera.shape = shape
        return StudioLook(background: background, padding: padding, rounding: rounding, shadow: shadow, aspect: aspect, camera: camera)
    }

    public static let builtIn: [StudioPreset] = [
        StudioPreset(id: "cap.studio", name: "Studio", look: .studioDefault),
        StudioPreset(id: "cap.sky", name: "Sky", look: look(.glow("sky"), padding: 0.08, rounding: 0.08, shadow: 0.45)),
        StudioPreset(id: "cap.dusk", name: "Dusk", look: look(.glow("dusk"), corner: .bottomLeading)),
        StudioPreset(id: "cap.ocean", name: "Ocean", look: look(.wallpaper("blue-3"))),
        StudioPreset(id: "cap.ember", name: "Ember", look: look(.wallpaper("orange-5"))),
        StudioPreset(id: "cap.nebula", name: "Nebula", look: look(.wallpaper("purple-4"), corner: .bottomLeading, shape: .rounded)),
        StudioPreset(id: "cap.graphite", name: "Graphite", look: look(.wallpaper("dark-5"), padding: 0.07, rounding: 0.06, shadow: 0.85)),
        StudioPreset(id: "cap.mint", name: "Mint", look: look(.glow("mint"), padding: 0.08, rounding: 0.08, shadow: 0.45, shape: .rounded)),
        StudioPreset(id: "cap.paper", name: "Paper", look: look(.color(StudioColor(236, 236, 241)), padding: 0.07, rounding: 0.05, shadow: 0.35, shape: .rounded)),
        StudioPreset(id: "cap.vertical", name: "Vertical", look: look(.wallpaper("dark-2"), aspect: .portrait, padding: 0.05, rounding: 0.05, shadow: 0.6, layout: .split)),
        StudioPreset(id: "cap.square", name: "Square", look: look(StudioBackground.gradients[1], aspect: .square, padding: 0.06, rounding: 0.06, shadow: 0.6, size: 0.3)),
        StudioPreset(id: "cap.widescreen", name: "Widescreen", look: look(.wallpaper("purple-2"), aspect: .landscape, padding: 0.06, rounding: 0.05, shadow: 0.7, size: 0.3)),
    ]
}

/// Someone's saved presets and the one new recordings start with.
public struct StudioPresetLibrary: Codable, Sendable, Hashable {
    public var saved: [StudioPreset]
    public var defaultId: String?

    public init(saved: [StudioPreset] = [], defaultId: String? = nil) {
        self.saved = saved
        self.defaultId = defaultId
    }

    /// Yours first, newest first, then Cap's.
    public var all: [StudioPreset] { saved + StudioPreset.builtIn }

    /// Falls back to Cap's Studio look when the chosen preset has been deleted.
    public var defaultPreset: StudioPreset {
        all.first { $0.id == defaultId } ?? StudioPreset.builtIn[0]
    }

    /// The preset a look came from, if it hasn't been changed since.
    public func preset(matching look: StudioLook) -> StudioPreset? {
        all.first { $0.look == look }
    }

    /// "My Look", then "My Look 2" and so on, so two presets never share a name.
    public func uniqueName(_ name: String) -> String {
        let base = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let root = base.isEmpty ? "My Look" : String(base.prefix(40))
        let taken = Set(all.map { $0.name.lowercased() })
        guard taken.contains(root.lowercased()) else { return root }
        var index = 2
        while taken.contains("\(root) \(index)".lowercased()) { index += 1 }
        return "\(root) \(index)"
    }
}

/// Presets sit beside a person's drafts rather than among them: every folder in the drafts is a recording, and one
/// with no tracks in it is cleared away as a failed recording.
public final class StudioPresetStore: @unchecked Sendable {
    public let root: URL
    private let lock = NSLock()

    public init(root: URL) {
        self.root = root
    }

    private var file: URL { root.appending(path: "presets.json") }

    public func load() -> StudioPresetLibrary {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? Data(contentsOf: file) else { return StudioPresetLibrary() }
        return (try? JSONDecoder().decode(StudioPresetLibrary.self, from: data)) ?? StudioPresetLibrary()
    }

    public func save(_ library: StudioPresetLibrary) throws {
        lock.lock()
        defer { lock.unlock() }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONEncoder().encode(library).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        removeUnusedImages(library)
    }

    public func imageURL(_ name: String) -> URL {
        root.appending(path: name)
    }

    /// A photo background is copied in when its preset is saved, because the recording it came from can be deleted.
    public func keepImage(named name: String, from source: URL) throws {
        let target = imageURL(name)
        guard !FileManager.default.fileExists(atPath: target.path) else { return }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: source, to: target)
    }

    /// Copies a preset's photo into the folder that's using it. Nothing to do for any other background.
    public func provideImage(for look: StudioLook, in directory: URL) {
        guard case let .image(name) = look.background else { return }
        let target = directory.appending(path: name)
        guard !FileManager.default.fileExists(atPath: target.path) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? FileManager.default.copyItem(at: imageURL(name), to: target)
    }

    private func removeUnusedImages(_ library: StudioPresetLibrary) {
        let used = Set(library.saved.compactMap { preset -> String? in
            if case let .image(name) = preset.look.background { name } else { nil }
        })
        let files = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        for name in files where name != "presets.json" && !used.contains(name) {
            try? FileManager.default.removeItem(at: root.appending(path: name))
        }
    }
}

extension StudioStore {
    /// `Users/<id>.presets`, next to `Users/<id>`. Account folder names never contain a dot, so it can't be taken by
    /// another account.
    public var presets: StudioPresetStore {
        StudioPresetStore(root: root.deletingLastPathComponent().appending(path: "\(root.lastPathComponent).presets", directoryHint: .isDirectory))
    }
}
