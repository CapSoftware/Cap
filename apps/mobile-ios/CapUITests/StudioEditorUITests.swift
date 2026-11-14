import XCTest

/// The Studio editor end to end on a recorded screen and camera (`CAP_STUDIO_FIXTURE`, a folder holding `screen.mp4`
/// and `camera.mp4`): every tool, the camera dragged to another corner, a cut, and a render saved to Photos.
final class StudioEditorUITests: XCTestCase {
    private static let key = "0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e"

    private var fixtureURL: String {
        ProcessInfo.processInfo.environment["CAP_FIXTURE_URL"] ?? "http://localhost:4310"
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipIf(ProcessInfo.processInfo.environment["CAP_STUDIO_FIXTURE"] == nil, "Set CAP_STUDIO_FIXTURE to a folder with screen.mp4 and camera.mp4")
    }

    private func save(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let directory = ProcessInfo.processInfo.environment["CAP_SHOT_DIR"] else { return }
        try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
    }

    private func openStudio(script: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["CAP_API_BASE_URL"] = fixtureURL
        app.launchEnvironment["CAP_DEBUG_SESSION"] = "\(Self.key):user_richie"
        app.launchEnvironment["CAP_DEBUG_ROUTE"] = "studio:\(ProcessInfo.processInfo.environment["CAP_STUDIO_FIXTURE"]!)"
        app.launchEnvironment["CAP_DEBUG_STUDIO_CAMERA_OFFSET"] = "0.4"
        if script { app.launchEnvironment["CAP_DEBUG_EDITOR_SCRIPT"] = "1" }
        app.launch()
        XCTAssertTrue(app.buttons["Split"].waitForExistence(timeout: 30))
        return app
    }

    func testEveryTool() throws {
        let app = openStudio()
        sleep(2)
        save("s00-studio-open")

        app.buttons["editor-tool-background"].tap()
        sleep(1)
        save("s01-background")
        // The strip opens on the chosen background; the wallpapers are just before it.
        let wallpapers = app.buttons.matching(identifier: "Wallpaper").allElementsBoundByIndex
        let visible = try XCTUnwrap(wallpapers.last { $0.isHittable })
        visible.tap()
        sleep(1)
        save("s02-wallpaper")

        app.buttons["editor-tool-frame"].tap()
        sleep(1)
        app.buttons["1:1"].tap()
        sleep(2)
        save("s03-square")
        app.buttons["Original"].tap()
        sleep(1)

        app.buttons["editor-tool-camera"].tap()
        // Past the camera's late start, so the bubble has a picture.
        timelineTap(app, 0.3)
        sleep(2)
        save("s04-camera")
        // Drag the bubble from its corner to the top left.
        let preview = app.descendants(matching: .any)["editor-preview"].firstMatch
        let bubble = app.descendants(matching: .any)["editor-camera-bubble"].firstMatch
        XCTAssertTrue(bubble.exists)
        let before = bubble.frame
        bubble.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: preview.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.12)))
        sleep(2)
        let after = app.descendants(matching: .any)["editor-camera-bubble"].firstMatch.frame
        XCTAssertLessThan(after.midX, before.midX)
        XCTAssertLessThan(after.midY, before.midY)
        save("s05-camera-moved")
        app.buttons["Split"].firstMatch.tap()
        sleep(2)
        save("s06-split-layout")
        app.buttons["Bubble"].tap()
        sleep(1)

        app.buttons["editor-tool-music"].tap()
        sleep(1)
        app.buttons["Lofi Beats"].tap()
        sleep(2)
        save("s07-music")

        app.buttons["editor-tool-trim"].tap()
        sleep(1)
        let timeline = app.descendants(matching: .any)["editor-timeline"].firstMatch
        timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.5)).tap()
        sleep(1)
        app.buttons["Split"].tap()
        sleep(1)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Clip 2'")).firstMatch.exists)
        save("s08-split")
        app.buttons["Undo"].tap()
        sleep(1)
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Clip 2'")).firstMatch.exists)
    }

    private func timelineTap(_ app: XCUIApplication, _ fraction: CGFloat) {
        app.descendants(matching: .any)["editor-timeline"].firstMatch.coordinate(withNormalizedOffset: CGVector(dx: fraction, dy: 0.5)).tap()
    }

    /// Records the camera in Studio Mode with a video played in as the camera (the simulator has none), through the
    /// real encoder, then lands in the editor with the recording kept as a draft.
    func testStudioCameraRecordingOpensEditor() throws {
        let app = XCUIApplication()
        app.launchEnvironment["CAP_API_BASE_URL"] = fixtureURL
        app.launchEnvironment["CAP_DEBUG_SESSION"] = "\(Self.key):user_richie"
        app.launchEnvironment["CAP_DEBUG_RECORDER_FILE"] = ProcessInfo.processInfo.environment["CAP_STUDIO_FIXTURE"]! + "/camera.mp4"
        app.launch()
        let tab = app.tabBars.buttons["Record"]
        XCTAssertTrue(tab.waitForExistence(timeout: 20))
        let hittable = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: tab)
        wait(for: [hittable], timeout: 10)
        tab.tap()
        let studio = app.buttons["Studio Mode"]
        if studio.waitForExistence(timeout: 10) { studio.tap() }
        XCTAssertTrue(app.staticTexts["Studio Mode"].waitForExistence(timeout: 5))
        app.buttons["Camera"].firstMatch.tap()
        let record = app.buttons["Start recording"]
        XCTAssertTrue(record.waitForExistence(timeout: 15))
        let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: record)
        wait(for: [enabled], timeout: 15)
        save("s20-studio-recorder")
        record.tap()
        sleep(5)
        save("s21-studio-recording")
        app.buttons["Stop recording"].tap()
        // The editor opens on the recording.
        XCTAssertTrue(app.buttons["Split"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.navigationBars["Studio"].exists)
        sleep(2)
        save("s22-studio-recorded")
        let length = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Edited length'")).firstMatch
        XCTAssertTrue(length.exists)
        // About five seconds recorded; never the debug file's own length.
        XCTAssertTrue(length.label.contains("0:04") || length.label.contains("0:05") || length.label.contains("0:06"), length.label)
        app.buttons["Done"].tap()
        // Back on the recorder, the recording waits as a draft.
        XCTAssertTrue(app.descendants(matching: .any)["studio-drafts"].waitForExistence(timeout: 10))
        save("s23-studio-drafts")
        app.buttons["Instant Mode"].tap()
    }

    /// Runs the editor's own scripted session and leaves `EditorStats.jsonl` in the app's caches.
    func testScriptedMeasurements() throws {
        let app = openStudio(script: true)
        // The script closes the editor when it's done.
        let closed = app.buttons["Split"].waitForNonExistence(timeout: 120)
        XCTAssertTrue(closed)
        sleep(1)
    }
}
