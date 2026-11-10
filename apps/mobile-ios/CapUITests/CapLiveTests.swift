import XCTest

/// End-to-end checks against a real local Cap web server. Skipped unless CAP_LIVE_URL is set.
/// CAP_LIVE_OWNER / CAP_LIVE_VIEWER are "apiKey:userId" sessions; CAP_LIVE_CAP is a public Cap
/// owned by the owner, CAP_LIVE_LOCKED a password-protected one (password in CAP_LIVE_PASSWORD).
@MainActor
final class CapLiveTests: XCTestCase {
    private let env = ProcessInfo.processInfo.environment

    private func require(_ key: String) throws -> String {
        guard let value = env[key], !value.isEmpty else { throw XCTSkip("\(key) not set") }
        return value
    }

    private func launch(session: String, route: String? = nil, recorderFile: String? = nil) throws -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        if let recorderFile { app.launchEnvironment["CAP_DEBUG_RECORDER_FILE"] = recorderFile }
        app.launchEnvironment["CAP_API_BASE_URL"] = try require("CAP_LIVE_URL")
        app.launchEnvironment["CAP_DEBUG_SESSION"] = session
        if let route { app.launchEnvironment["CAP_DEBUG_ROUTE"] = route }
        app.launch()
        return app
    }

    /// Taps a tab bar item once it can really be hit; a tap computed while something covers the
    /// tab bar lands on whatever is behind it.
    private func tapTab(_ app: XCUIApplication, _ label: String) {
        let tab = app.tabBars.buttons[label]
        XCTAssertTrue(tab.waitForExistence(timeout: 20))
        let hittable = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: tab)
        wait(for: [hittable], timeout: 10)
        tab.tap()
    }

    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let directory = env["CAP_SHOT_DIR"] else { return }
        try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("live-\(name).png"))
    }

    func testUploadFromPhotos() throws {
        let app = try launch(session: try require("CAP_LIVE_OWNER"))
        let add = app.buttons["Add"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        add.tap()
        app.buttons["Upload from Photos"].tap()
        // The picker runs out of process; its cells still show up in the app's tree.
        let picked = app.images.matching(NSPredicate(format: "label CONTAINS[c] 'video' OR label CONTAINS[c] 'Video'")).firstMatch
        XCTAssertTrue(picked.waitForExistence(timeout: 15), "No video in the photo picker")
        shot("01-picker")
        picked.tap()
        let add2 = app.buttons["Add"]
        if add2.waitForExistence(timeout: 2), add2.isHittable { add2.tap() }
        XCTAssertTrue(app.staticTexts["Uploaded"].waitForExistence(timeout: 120), "Upload never finished")
        shot("02-uploaded")
    }

    /// Starts a large upload, leaves Cap, and checks it finished in the background with a Live Activity.
    func testBackgroundUploadWithLiveActivity() throws {
        let app = try launch(session: try require("CAP_LIVE_OWNER"))
        let add = app.buttons["Add"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        add.tap()
        app.buttons["Upload from Photos"].tap()
        let picked = app.images.matching(NSPredicate(format: "label CONTAINS[c] 'video'")).firstMatch
        XCTAssertTrue(picked.waitForExistence(timeout: 15), "No video in the photo picker")
        picked.tap()
        let addButton = app.buttons["Add"]
        if addButton.waitForExistence(timeout: 2), addButton.isHittable { addButton.tap() }
        let uploading = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Uploading'")).firstMatch
        if !uploading.waitForExistence(timeout: 60) {
            shot("40-FAIL-not-uploading")
            XCTFail("Upload never started")
            return
        }
        sleep(3)
        shot("40-uploading-in-app")
        XCUIDevice.shared.press(.home)
        sleep(3)
        shot("41-dynamic-island")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        springboard.swipeDown(velocity: .fast)
        sleep(2)
        shot("42-lock-screen-activity")
        springboard.swipeUp(velocity: .fast)
        sleep(20)
        shot("43-island-later")
        app.activate()
        XCTAssertTrue(app.staticTexts["Uploaded"].waitForExistence(timeout: 120), "Upload didn't finish in the background")
        shot("44-finished")
    }

    /// Picks a video and leaves Cap straight away, before the upload has started.
    /// The Live Activity has to exist already, because iOS won't start one for a backgrounded app.
    func testLeavingImmediatelyStillShowsLiveActivity() throws {
        let app = try launch(session: try require("CAP_LIVE_OWNER"))
        let add = app.buttons["Add"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        add.tap()
        app.buttons["Upload from Photos"].tap()
        let picked = app.images.matching(NSPredicate(format: "label CONTAINS[c] 'video'")).firstMatch
        XCTAssertTrue(picked.waitForExistence(timeout: 15), "No video in the photo picker")
        picked.tap()
        XCUIDevice.shared.press(.home)
        sleep(4)
        shot("50-left-immediately-island")
        sleep(6)
        shot("51-left-immediately-island-later")
        app.activate()
        XCTAssertTrue(app.staticTexts["Uploaded"].waitForExistence(timeout: 120), "Upload didn't finish after leaving immediately")
        shot("52-left-immediately-finished")
    }

    /// Records from a file standing in for the camera, stops, and checks the new Cap opens with its link copied.
    func testCameraRecording() throws {
        let file = try require("CAP_LIVE_RECORDER_FILE")
        let seconds = UInt32(env["CAP_LIVE_RECORD_SECONDS"] ?? "") ?? 9
        let app = try launch(session: try require("CAP_LIVE_OWNER"), recorderFile: file)
        tapTab(app, "Record")
        let camera = app.buttons["Camera"]
        if camera.waitForExistence(timeout: 5) { camera.tap() }
        sleep(1)
        shot("59-after-tab")
        let start = app.buttons["Start recording"]
        if !start.waitForExistence(timeout: 10) {
            shot("60-FAIL-no-recorder")
            print(app.debugDescription)
            XCTFail("Recorder didn't open")
            return
        }
        shot("60-recorder-ready")
        start.tap()
        let stop = app.buttons["Stop recording"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        sleep(seconds)
        shot("61-recording")
        stop.tap()
        let copied = app.staticTexts["Link copied"].waitForExistence(timeout: 10)
        let opened = app.segmentedControls.firstMatch.waitForExistence(timeout: 20)
        shot("62-after-stop")
        XCTAssertTrue(copied, "The link wasn't copied")
        XCTAssertTrue(opened, "The new Cap didn't open after stopping")
        sleep(6)
        shot("63-processing")
    }

    /// Switches the recorder to screen mode and opens the system broadcast sheet.
    func testScreenModeOpensBroadcastSheet() throws {
        let app = try launch(session: try require("CAP_LIVE_OWNER"), recorderFile: env["CAP_LIVE_RECORDER_FILE"])
        tapTab(app, "Record")
        let screen = app.buttons["Screen"]
        XCTAssertTrue(screen.waitForExistence(timeout: 10))
        screen.tap()
        let start = app.buttons["Start screen recording"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        sleep(1)
        shot("70-screen-mode")
        start.tap()
        sleep(3)
        shot("71-broadcast-sheet")
        app.buttons["Camera"].firstMatch.tap()
        sleep(2)
        shot("72-back-to-camera")
    }

    func testLoomImport() throws {
        let link = try require("CAP_LIVE_LOOM")
        let app = try launch(session: try require("CAP_LIVE_OWNER"))
        let add = app.buttons["Add"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        add.tap()
        app.buttons["Import from Loom"].tap()
        let field = app.textFields["https://www.loom.com/share/…"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(link)
        shot("10-loom")
        app.buttons["Import"].tap()
        let opened = app.segmentedControls.firstMatch.waitForExistence(timeout: 60) || app.staticTexts["Importing from Loom"].waitForExistence(timeout: 5)
        shot("11-loom-imported")
        XCTAssertTrue(opened, "Loom import didn't open the new Cap")
    }

    func testViewerCommentsOnSomeoneElsesCap() throws {
        let cap = try require("CAP_LIVE_CAP")
        let app = try launch(session: try require("CAP_LIVE_VIEWER"), route: "cap:\(cap)")
        let react = app.buttons["React with 😍"]
        XCTAssertTrue(react.waitForExistence(timeout: 20), "Viewer couldn't open the Cap")
        react.tap()
        let field = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Live comment from another account")
        app.buttons["Send comment"].tap()
        XCTAssertTrue(app.staticTexts["Live comment from another account"].waitForExistence(timeout: 15))
        sleep(2)
        XCTAssertFalse(app.staticTexts["Sending…"].exists, "Comment stayed pending")
        shot("20-viewer-commented")
    }

    func testViewerUnlocksPasswordCap() throws {
        let cap = try require("CAP_LIVE_LOCKED")
        let password = try require("CAP_LIVE_PASSWORD")
        let app = try launch(session: try require("CAP_LIVE_VIEWER"), route: "cap:\(cap)")
        let field = app.secureTextFields["Password"]
        XCTAssertTrue(field.waitForExistence(timeout: 20), "No password gate")
        shot("30-gate")
        field.tap()
        field.typeText(password)
        app.buttons["Watch Cap"].tap()
        XCTAssertTrue(app.buttons["React with 😍"].waitForExistence(timeout: 20), "Unlock didn't open the Cap")
        shot("31-unlocked")
    }
}
