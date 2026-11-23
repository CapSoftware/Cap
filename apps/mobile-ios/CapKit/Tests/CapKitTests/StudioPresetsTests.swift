@testable import CapKit
import CoreImage
import Foundation
import Testing

@Suite struct StudioPresetsTests {
    private func temporaryStore() -> StudioStore {
        StudioStore(root: FileManager.default.temporaryDirectory.appending(path: "presets-\(UUID().uuidString)/Users/user_a", directoryHint: .isDirectory))
    }

    @Test func capPresetsAreDistinct() {
        let presets = StudioPreset.builtIn
        #expect(presets.first?.look == .studioDefault)
        #expect(Set(presets.map(\.id)).count == presets.count)
        #expect(Set(presets.map(\.name)).count == presets.count)
        #expect(Set(presets.map(\.look)).count == presets.count)
        #expect(presets.allSatisfy { $0.isBuiltIn })
        #expect(!StudioPreset(name: "Mine", look: .studioDefault).isBuiltIn)
        // Every preset frames the video: none is the plain recording.
        #expect(presets.allSatisfy { !$0.look.background.isNone && $0.look.padding > 0 })
    }

    @Test func savedPresetsAndTheDefaultRoundTrip() throws {
        let store = temporaryStore().presets
        #expect(store.load() == StudioPresetLibrary())
        #expect(store.load().defaultPreset.id == "cap.studio")
        var look = StudioLook.studioDefault
        look.aspect = .square
        let mine = StudioPreset(name: "Launch", look: look)
        try store.save(StudioPresetLibrary(saved: [mine], defaultId: mine.id))
        let loaded = store.load()
        #expect(loaded.saved == [mine])
        #expect(loaded.defaultPreset == mine)
        #expect(loaded.all.first == mine)
        #expect(loaded.preset(matching: look) == mine)
        // A default that's been deleted falls back to Cap's Studio look.
        try store.save(StudioPresetLibrary(saved: [], defaultId: mine.id))
        #expect(store.load().defaultPreset.id == "cap.studio")
    }

    @Test func presetsAreNeverMistakenForARecording() throws {
        let drafts = temporaryStore()
        try drafts.presets.save(StudioPresetLibrary(saved: [StudioPreset(name: "Mine", look: .studioDefault)]))
        // Recovery treats every folder in the drafts as a recording and clears ones with no tracks.
        let inDrafts = (try? FileManager.default.contentsOfDirectory(atPath: drafts.root.path)) ?? []
        #expect(inDrafts.isEmpty)
        #expect(!drafts.presets.root.path.hasPrefix(drafts.root.path + "/"))
        #expect(drafts.all().isEmpty)
        // Another account's presets are its own.
        let other = StudioStore(root: drafts.root.deletingLastPathComponent().appending(path: "user_b", directoryHint: .isDirectory))
        #expect(other.presets.load().saved.isEmpty)
    }

    @Test func photoBackgroundsOutliveTheirRecording() throws {
        let drafts = temporaryStore()
        let project = drafts.directory(for: "p1")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try Data([1, 2, 3]).write(to: project.appending(path: "background-1.jpg"))
        let presets = drafts.presets
        try presets.keepImage(named: "background-1.jpg", from: project.appending(path: "background-1.jpg"))
        var look = StudioLook.studioDefault
        look.background = .image("background-1.jpg")
        try presets.save(StudioPresetLibrary(saved: [StudioPreset(name: "Photo", look: look)]))
        drafts.delete("p1")
        // Applied to a new recording, the photo is copied in beside it.
        let next = drafts.directory(for: "p2")
        presets.provideImage(for: look, in: next)
        #expect(FileManager.default.fileExists(atPath: next.appending(path: "background-1.jpg").path))
        // Once no preset uses it, it goes.
        try presets.save(StudioPresetLibrary())
        #expect(!FileManager.default.fileExists(atPath: presets.imageURL("background-1.jpg").path))
    }

    @Test func namesNeverRepeat() {
        let library = StudioPresetLibrary(saved: [StudioPreset(name: "My Look", look: .untouched), StudioPreset(name: "My Look 2", look: .untouched)])
        #expect(library.uniqueName("my look") == "my look 3")
        #expect(library.uniqueName("  Ocean ") == "Ocean 2")
        #expect(library.uniqueName("") == "My Look 3")
        #expect(library.uniqueName("Launch") == "Launch")
    }

    /// Thumbnails for every preset come from a renderer of their own: the preview's cached background must still be
    /// the preview's afterwards, or its next frame would pay to redraw it.
    @Test func thumbnailsLeaveThePreviewAlone() throws {
        let renderer = StudioRenderer()
        let screenSize = CGSize(width: 1179, height: 2556)
        let cameraSize = CGSize(width: 720, height: 1280)
        let screenInfo = StudioSourceInfo(naturalSize: screenSize)
        let cameraInfo = StudioSourceInfo(naturalSize: cameraSize)
        let screen = StudioRenderingTests.solid(screenSize, CIColor(red: 0.9, green: 0.9, blue: 0.9), renderer: renderer)
        let camera = StudioRenderingTests.solid(cameraSize, CIColor(red: 0.5, green: 0.4, blue: 0.3), renderer: renderer)
        let preview = StudioScene(look: .studioDefault, screen: screenInfo, camera: cameraInfo, renderer: renderer)
        let canvas = StudioLayout.canvasSize(look: .studioDefault, primary: screenSize, camera: cameraSize, longEdge: StudioLayout.previewLongEdge)
        _ = renderer.render(scene: preview, screen: screen, camera: camera, size: canvas)
        #expect(renderer.cachedLook?.look == .studioDefault)

        let thumbnails = renderer.sibling()
        #expect(thumbnails.context === renderer.context)
        var times: [Double] = []
        let first = CFAbsoluteTimeGetCurrent()
        _ = thumbnails.image(scene: StudioScene(look: .studioDefault, screen: screenInfo, camera: cameraInfo, renderer: thumbnails), screen: screen, camera: camera, size: CGSize(width: 64, height: 64))
        let warm = (CFAbsoluteTimeGetCurrent() - first) * 1000
        for _ in 0..<3 {
            for preset in StudioPreset.builtIn {
                let size = StudioLayout.canvasSize(look: preset.look, primary: screenSize, camera: cameraSize, longEdge: 360)
                let scene = StudioScene(look: preset.look, screen: screenInfo, camera: cameraInfo, renderer: thumbnails)
                let start = CFAbsoluteTimeGetCurrent()
                let image = try #require(thumbnails.image(scene: scene, screen: screen, camera: camera, size: size))
                times.append((CFAbsoluteTimeGetCurrent() - start) * 1000)
                #expect(image.width == Int(size.width) && image.height == Int(size.height))
            }
        }
        #expect(renderer.cachedLook?.look == .studioDefault)
        #expect(renderer.cachedLook?.size == canvas)

        times.sort()
        let p50 = times[times.count / 2]
        let worst = times.last ?? 0
        print("STUDIO_BENCH preset thumbnail first \(String(format: "%.1f", warm)) ms, then p50 \(String(format: "%.2f", p50)) ms max \(String(format: "%.2f", worst)) ms over \(times.count)")
        // About 2.5 ms on an M4 when it's quiet. They're drawn off the main thread, so a frame at 60 fps is the bound.
        if ProcessInfo.processInfo.environment["CI"] == nil {
            #expect(p50 < 16)
        }
    }

    @Test func thumbnailShowsThePresetsLayout() throws {
        let renderer = StudioRenderer().sibling()
        let screenSize = CGSize(width: 590, height: 1278)
        let cameraSize = CGSize(width: 360, height: 640)
        let preset = try #require(StudioPreset.builtIn.first { $0.id == "cap.vertical" })
        let size = StudioLayout.canvasSize(look: preset.look, primary: screenSize, camera: cameraSize, longEdge: 360)
        #expect(abs(size.width / size.height - 9.0 / 16) < 0.01)
        let scene = StudioScene(look: preset.look, screen: StudioSourceInfo(naturalSize: screenSize), camera: StudioSourceInfo(naturalSize: cameraSize), renderer: renderer)
        let image = try #require(renderer.image(scene: scene, screen: StudioRenderingTests.solid(screenSize, CIColor(red: 1, green: 0, blue: 0), renderer: renderer), camera: StudioRenderingTests.solid(cameraSize, CIColor(red: 0, green: 1, blue: 0), renderer: renderer), size: size))
        let layout = StudioLayout(look: preset.look, canvas: size, primary: screenSize, camera: cameraSize)
        let screenFrame = try #require(layout.screen?.frame)
        let cameraFrame = try #require(layout.camera?.frame)
        // Split: screen on top, camera underneath.
        #expect(screenFrame.maxY <= cameraFrame.minY)
        let pixels = try #require(image.dataProvider?.data as Data?)
        func pixel(_ x: CGFloat, _ y: CGFloat) -> (r: Int, g: Int, b: Int) {
            let offset = Int(y) * image.bytesPerRow + Int(x) * 4
            return (Int(pixels[offset]), Int(pixels[offset + 1]), Int(pixels[offset + 2]))
        }
        let top = pixel(screenFrame.midX, screenFrame.midY)
        #expect(top.r > 230 && top.g < 30)
        let bottom = pixel(cameraFrame.midX, cameraFrame.midY)
        #expect(bottom.g > 230 && bottom.r < 30)
    }
}

@Suite struct StudioGlowTests {
    @Test func everyGlowRoundTrips() throws {
        #expect(Set(StudioGlow.all.map(\.id)).count == StudioGlow.all.count)
        for background in StudioBackground.glows {
            var look = StudioLook.studioDefault
            look.background = background
            #expect(try JSONDecoder().decode(StudioLook.self, from: JSONEncoder().encode(look)) == look)
        }
    }

    /// Each bloom shows its own colour where it sits, the base shows where none reach, and the background is drawn
    /// once per look, so its cost only has to stay well under a frame.
    @Test func bloomsLandWhereTheyAreDefined() throws {
        let renderer = StudioRenderer()
        let size = CGSize(width: 1080, height: 1920)
        var times: [Double] = []
        for glow in StudioGlow.all {
            let start = CFAbsoluteTimeGetCurrent()
            let image = StudioRenderer.glow(glow, size: size)
            let cg = try #require(renderer.context.createCGImage(image, from: CGRect(origin: .zero, size: size), format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!))
            times.append((CFAbsoluteTimeGetCurrent() - start) * 1000)
            let data = try #require(cg.dataProvider?.data as Data?)
            func pixel(_ x: Double, _ y: Double) -> (Double, Double, Double) {
                let px = min(cg.width - 1, max(0, Int(x * Double(cg.width))))
                let py = min(cg.height - 1, max(0, Int(y * Double(cg.height))))
                let o = py * cg.bytesPerRow + px * 4
                return (Double(data[o]), Double(data[o + 1]), Double(data[o + 2]))
            }
            func distance(_ a: (Double, Double, Double), _ c: StudioColor) -> Double {
                let b = (Double(c.red), Double(c.green), Double(c.blue))
                return ((a.0 - b.0) * (a.0 - b.0) + (a.1 - b.1) * (a.1 - b.1) + (a.2 - b.2) * (a.2 - b.2)).squareRoot()
            }
            // The bloom that stands out most from the base must pull the colour where it sits towards its own.
            let base = (Double(glow.base.red), Double(glow.base.green), Double(glow.base.blue))
            let boldest = try #require(glow.blooms.max { distance(base, $0.color) < distance(base, $1.color) })
            let atBloom = pixel(boldest.x, boldest.y)
            #expect(distance(atBloom, boldest.color) < distance(base, boldest.color) * 0.8, "\(glow.id)")
            // Smooth: neighbouring pixels a few apart never jump.
            let a = pixel(0.5, 0.5)
            let b = pixel(0.5 + 4.0 / 1080, 0.5)
            #expect(abs(a.0 - b.0) < 6 && abs(a.1 - b.1) < 6 && abs(a.2 - b.2) < 6, "\(glow.id)")
        }
        times.sort()
        print("STUDIO_BENCH glow 1080x1920 p50 \(String(format: "%.2f", times[times.count / 2])) ms max \(String(format: "%.2f", times.last ?? 0)) ms")
    }

    /// Padding drags redraw the frame's still parts each step; the glow beneath is drawn once.
    @Test func dragsDontRedrawTheGlow() throws {
        let renderer = StudioRenderer()
        let screenSize = CGSize(width: 1179, height: 2556)
        let screen = StudioRenderingTests.solid(screenSize, CIColor(red: 0.9, green: 0.9, blue: 0.9), renderer: renderer)
        var look = StudioLook.studioDefault
        look.background = .glow("dusk")
        let scene = StudioScene(look: look, screen: StudioSourceInfo(naturalSize: screenSize), camera: nil, renderer: renderer)
        let canvas = StudioLayout.canvasSize(look: look, primary: screenSize, camera: nil, longEdge: StudioLayout.previewLongEdge)
        _ = renderer.render(scene: scene, screen: screen, camera: nil, size: canvas)
        var times: [Double] = []
        for step in 1...30 {
            scene.update { $0.look.padding = 0.05 + Double(step) * 0.002 }
            let start = CFAbsoluteTimeGetCurrent()
            _ = renderer.render(scene: scene, screen: screen, camera: nil, size: canvas)
            times.append((CFAbsoluteTimeGetCurrent() - start) * 1000)
        }
        times.sort()
        let p50 = times[times.count / 2]
        print("STUDIO_BENCH glow padding drag step p50 \(String(format: "%.2f", p50)) ms max \(String(format: "%.2f", times.last ?? 0)) ms")
        if ProcessInfo.processInfo.environment["CI"] == nil {
            #expect(p50 < 16)
        }
    }
}
