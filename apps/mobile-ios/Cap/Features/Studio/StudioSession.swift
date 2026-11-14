@preconcurrency import AVFoundation
import CapKit
import Observation
import os
import UIKit

/// Studio Mode keeps recordings on the phone as separate screen and camera tracks, so they can be laid out, styled
/// and cut before anything is shared.
@MainActor
@Observable
final class StudioSession {
    static let shared = StudioSession()
    private static let log = Logger(subsystem: "so.cap.mobile", category: "studio")

    let store = StudioStore.shared()
    private(set) var projects: [StudioProject] = []
    /// The editor to show next, wherever Cap is.
    var editing: StudioProject?
    /// A screen recording has stopped and its file is being closed.
    private(set) var isFinishingScreen = false

    /// The project the next screen recording goes into, set before the system sheet can start it.
    @ObservationIgnored private var armedProjectId: String?
    @ObservationIgnored private var armedAt: Date = .distantPast
    @ObservationIgnored private var screenCamera: (writer: StudioTrackWriter, projectId: String)?
    @ObservationIgnored private var recordingProjectId: String?
    @ObservationIgnored weak var session: SessionModel?

    private init() {}

    func reload() {
        projects = store.all()
        if !recovered { Task { await recoverInterrupted() } }
    }

    // MARK: Screen

    /// iOS only lets its own button start a broadcast, so the extension can't be told at tap time. Cap leaves a
    /// request for it whenever Studio's screen mode is showing; the extension takes it if it starts within its life.
    func armScreenRecording() {
        guard recordingProjectId == nil else { return }
        if armedProjectId == nil || Date.now.timeIntervalSince(armedAt) > StudioScreenRequest.lifetime / 2 {
            armedProjectId = UUID().uuidString.lowercased()
            armedAt = .now
        }
        guard let armedProjectId else { return }
        StudioScreenRequest.set(.init(projectId: armedProjectId, requestedAt: armedAt), in: store)
    }

    /// Instant Mode's screen recordings must never land in Studio.
    func disarmScreenRecording() {
        guard recordingProjectId == nil else { return }
        armedProjectId = nil
        StudioScreenRequest.set(nil, in: store)
    }

    var isRecordingScreen: Bool { recordingProjectId != nil }

    /// The broadcast started. Whether it took the request is only known from the request being gone.
    func screenRecordingBegan(withCamera: Bool, bubble: CameraBubble) {
        guard let projectId = armedProjectId, StudioScreenRequest.peek(in: store) == nil else { return }
        recordingProjectId = projectId
        armedProjectId = nil
        Usage.track("recording_started", ["mode": "studio_screen", "camera": .bool(withCamera)])
        guard withCamera else { return }
        do {
            let directory = store.directory(for: projectId)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let writer = try StudioTrackWriter(url: directory.appending(path: "camera.mp4"), settings: .init(kind: .camera, audio: false), clock: bubble.captureClock) { hostStart in
                try? StudioTrackInfo(file: "camera.mp4", hostStart: hostStart, duration: 0).save(as: "camera", in: directory)
            }
            screenCamera = (writer, projectId)
            bubble.beginStudioRecording(writer)
        } catch {
            Self.log.error("Studio camera didn't start: \(String(describing: error), privacy: .public)")
        }
    }

    /// The broadcast ended, from anywhere. Waits for the extension to close its file, then opens the editor.
    func screenRecordingEnded(bubble: CameraBubble) {
        guard let projectId = recordingProjectId else { return }
        recordingProjectId = nil
        isFinishingScreen = true
        let camera = screenCamera
        screenCamera = nil
        Task {
            defer { isFinishingScreen = false }
            var cameraInfo: StudioTrackInfo?
            if let camera {
                cameraInfo = await bubble.endStudioRecording(camera.writer)
                try? cameraInfo?.save(as: "camera", in: store.directory(for: projectId))
            }
            let directory = store.directory(for: projectId)
            // Usually there before Cap notices the stop; the extension has a few seconds to close the file.
            for _ in 0..<100 where StudioTrackInfo.load("screen", in: directory) == nil {
                try? await Task.sleep(for: .milliseconds(100))
            }
            await assemble(projectId: projectId, screen: StudioTrackInfo.load("screen", in: directory), camera: cameraInfo, title: Self.title(for: .now, screen: true))
        }
    }

    // MARK: Camera

    /// Saves a finished camera-only recording as a project and opens it.
    func cameraRecordingFinished(projectId: String, camera: StudioTrackInfo) async {
        try? camera.save(as: "camera", in: store.directory(for: projectId))
        await assemble(projectId: projectId, screen: nil, camera: camera, title: Self.title(for: .now, screen: false))
    }

    /// A track whose process ended before closing it has a start but no length; its file says how much was kept.
    private func resolve(_ info: StudioTrackInfo?, in directory: URL) async -> StudioTrackInfo? {
        guard var info else { return nil }
        let url = directory.appending(path: info.file)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        if info.duration <= 0 {
            info.duration = (try? await AVURLAsset(url: url).load(.duration).seconds).flatMap { $0.isFinite ? $0 : nil } ?? 0
        }
        return info.duration > 0 ? info : nil
    }

    private func assemble(projectId: String, screen: StudioTrackInfo?, camera: StudioTrackInfo?, title: String, opens: Bool = true) async {
        let directory = store.directory(for: projectId)
        let screen = await resolve(screen, in: directory)
        let camera = await resolve(camera, in: directory)
        let aligned = StudioTrackInfo.align(screen: screen, camera: camera)
        var project = StudioProject(id: projectId, title: title, screen: aligned.screen, camera: aligned.camera)
        guard !project.isEmpty, project.duration >= 1 else {
            store.delete(projectId)
            Usage.track("recording_discarded", ["mode": "studio", "reason": "too_short"])
            session?.toasts.show("Recording was too short", systemImage: "record.circle", style: .info)
            return
        }
        // A camera on its own is better shown large; a screen gets Cap's framing either way.
        if project.screen == nil { project.look.camera.layout = .cameraOnly }
        do {
            try store.save(project)
        } catch {
            Self.log.error("Studio project didn't save: \(String(describing: error), privacy: .public)")
            session?.toasts.show(error: error)
            return
        }
        Usage.track("recording_stopped", ["mode": "studio", "duration_seconds": .int(Int(project.duration.rounded())), "screen": .bool(project.screen != nil), "camera": .bool(project.camera != nil)])
        reload()
        guard opens else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        editing = project
    }

    // MARK: Recovery

    @ObservationIgnored private var recovered = false

    /// Recordings whose app or extension was killed before the project was saved. Their files are fragmented MP4s,
    /// so everything up to the last couple of seconds plays; they come back as drafts.
    func recoverInterrupted(now: Date = .now) async {
        guard !recovered else { return }
        recovered = true
        let fileManager = FileManager.default
        let ids = (try? fileManager.contentsOfDirectory(atPath: store.root.path)) ?? []
        for id in ids where id != recordingProjectId && id != armedProjectId {
            let directory = store.directory(for: id)
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue,
                  store.load(id) == nil
            else { continue }
            let files = (try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
            // Still being written by a recording that's running.
            let newest = files.compactMap { try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate }.max() ?? .distantPast
            guard now.timeIntervalSince(newest) > 60 else { continue }
            let screen = StudioTrackInfo.load("screen", in: directory)
            let camera = StudioTrackInfo.load("camera", in: directory)
            guard screen != nil || camera != nil else {
                store.delete(id)
                continue
            }
            Self.log.info("Recovering interrupted Studio recording \(id, privacy: .public)")
            await assemble(projectId: id, screen: screen, camera: camera, title: "Recovered recording", opens: false)
        }
    }


    func save(_ project: StudioProject) {
        do {
            try store.save(project)
            if let index = projects.firstIndex(where: { $0.id == project.id }) { projects[index] = project } else { reload() }
        } catch {
            Self.log.error("Studio project didn't save: \(String(describing: error), privacy: .public)")
        }
    }

    func delete(_ project: StudioProject) {
        store.delete(project.id)
        projects.removeAll { $0.id == project.id }
        Usage.track("studio_deleted")
    }

    func open(projectId: String) {
        guard let project = store.load(projectId) else { return }
        editing = project
    }

    static func title(for date: Date, screen: Bool) -> String {
        (screen ? "Studio Recording " : "Studio Camera ") + date.formatted(.dateTime.day().month(.abbreviated).year().hour().minute())
    }

    // MARK: Thumbnails

    @ObservationIgnored private var thumbnails: [String: UIImage] = [:]

    func thumbnail(for project: StudioProject) async -> UIImage? {
        if let image = thumbnails[project.id] { return image }
        guard let track = project.screen ?? project.camera else { return nil }
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: store.url(track.file, in: project.id)))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 240, height: 240)
        guard let image = try? await generator.image(at: CMTime(seconds: min(1, track.duration / 2), preferredTimescale: 600)).image else { return nil }
        let result = UIImage(cgImage: image)
        thumbnails[project.id] = result
        return result
    }
}

/// What Studio ships with: Cap desktop's wallpapers and music.
enum StudioAssets {
    struct Track: Identifiable, Hashable {
        let id: String
        let title: String
        var url: URL? { Bundle.main.url(forResource: id, withExtension: "m4a") }
    }

    static let music: [Track] = [
        Track(id: "lofi-beats-mirostar", title: "Lofi Beats"),
        Track(id: "raindrops-lofi-sleep-bluelike", title: "Raindrops"),
        Track(id: "sunday-mood-lofi-cafe-upbeat-bluelike", title: "Sunday Mood"),
        Track(id: "good-night-lofi-cozy-chill-fassounds", title: "Good Night"),
        Track(id: "ambient-trap-empty-streets-dreamstate-openmindaudio", title: "Empty Streets"),
        Track(id: "lofi-study-calm-peaceful-chill-hop-fassounds", title: "Study"),
        Track(id: "lofi-cinematic-pulsebox", title: "Cinematic"),
        Track(id: "lofi-hip-hop-leberch", title: "Hip Hop"),
        Track(id: "cassette-retrositive", title: "Cassette"),
        Track(id: "lofi-smooth-pulsebox", title: "Smooth"),
    ]

    static let wallpapers = ["blue-1", "blue-3", "blue-5", "purple-2", "purple-4", "orange-1", "orange-5", "orange-8", "dark-2", "dark-5"]

    static func wallpaperURL(_ name: String) -> URL? {
        Bundle.main.url(forResource: name, withExtension: "heic")
    }

    static func wallpaperThumbnail(_ name: String) -> UIImage? {
        Bundle.main.url(forResource: "\(name)-thumb", withExtension: "jpg").flatMap { UIImage(contentsOfFile: $0.path) }
    }

    /// Decoded straight to the size it's drawn at: a 2400 px wallpaper never needs to be held at full size.
    nonisolated static func loadImage(_ url: URL, maxPixels: Int = 2400) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
    }
}

#if DEBUG
/// Debug-only: `CAP_DEBUG_ROUTE=studio:<folder>` opens `screen.mp4` and `camera.mp4` from a folder as a Studio
/// project, so the simulator, which can't record either, can still exercise and measure the editor.
@MainActor
enum StudioDebug {
    static func openFixture(_ directory: URL) {
        Task {
            let store = StudioSession.shared.store
            let id = "fixture"
            store.delete(id)
            let target = store.directory(for: id)
            try? FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
            let cameraOffset = Double(ProcessInfo.processInfo.environment["CAP_DEBUG_STUDIO_CAMERA_OFFSET"] ?? "") ?? 0
            var tracks: [String: StudioProject.Track] = [:]
            for name in ["screen", "camera"] {
                let source = directory.appending(path: "\(name).mp4")
                guard FileManager.default.fileExists(atPath: source.path) else { continue }
                try? FileManager.default.copyItem(at: source, to: target.appending(path: "\(name).mp4"))
                let duration = (try? await AVURLAsset(url: source).load(.duration).seconds) ?? 0
                tracks[name] = StudioProject.Track(file: "\(name).mp4", offset: name == "camera" ? cameraOffset : 0, duration: duration)
            }
            var project = StudioProject(id: id, title: "Studio fixture", createdAt: .now, screen: tracks["screen"], camera: tracks["camera"])
            if project.screen == nil { project.look.camera.layout = .cameraOnly }
            try? store.save(project)
            StudioSession.shared.reload()
            StudioSession.shared.editing = project
        }
    }
}
#endif
