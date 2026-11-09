import XCTest

/// The editor end to end against the fixture: open from the Cap's menu, split, select and delete a clip, save.
/// Run against a fixture whose clip matches the Cap's length (`CAP_EDITOR_FIXTURE_URL`, default port 4312).
final class EditorUITests: XCTestCase {
    private static let key = "0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e"

    private var fixtureURL: String {
        ProcessInfo.processInfo.environment["CAP_EDITOR_FIXTURE_URL"] ?? "http://localhost:4312"
    }

    override func setUp() {
        continueAfterFailure = false
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

    func testSplitDeleteAndSave() throws {
        let app = XCUIApplication()
        app.launchEnvironment["CAP_API_BASE_URL"] = fixtureURL
        app.launchEnvironment["CAP_DEBUG_SESSION"] = "\(Self.key):user_richie"
        app.launchEnvironment["CAP_DEBUG_ROUTE"] = "cap:cap_london"
        app.launch()

        let more = app.buttons["More"].firstMatch
        XCTAssertTrue(more.waitForExistence(timeout: 20))
        more.tap()
        let edit = app.buttons["Edit"].firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap()

        let split = app.buttons["Split"]
        XCTAssertTrue(split.waitForExistence(timeout: 15))
        sleep(3)
        save("90-editor-open")

        // Move the playhead a third of the way along, then split there.
        let timeline = app.descendants(matching: .any)["editor-timeline"].firstMatch
        XCTAssertTrue(timeline.exists)
        timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.33, dy: 0.5)).tap()
        sleep(1)
        XCTAssertTrue(split.isEnabled)
        split.tap()
        sleep(1)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Clip 2'")).firstMatch.exists)

        // Select the first clip and delete it.
        timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5)).tap()
        sleep(1)
        save("91-editor-selected")
        let delete = app.buttons["Delete"]
        XCTAssertTrue(delete.isEnabled)
        delete.tap()
        sleep(2)
        save("92-editor-deleted")
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Clip 2'")).firstMatch.exists)

        let saveButton = app.buttons["Save"]
        XCTAssertTrue(saveButton.isEnabled)
        saveButton.tap()
        XCTAssertTrue(app.staticTexts["Saving your edit. Your Cap updates in a moment."].waitForExistence(timeout: 10))
        save("93-editor-saved")
        XCTAssertFalse(split.exists)
    }

    func testTrimHandlesDrag() throws {
        let app = XCUIApplication()
        app.launchEnvironment["CAP_API_BASE_URL"] = fixtureURL
        app.launchEnvironment["CAP_DEBUG_SESSION"] = "\(Self.key):user_richie"
        app.launchEnvironment["CAP_DEBUG_ROUTE"] = "cap:cap_london"
        app.launch()

        let more = app.buttons["More"].firstMatch
        XCTAssertTrue(more.waitForExistence(timeout: 20))
        more.tap()
        let edit = app.buttons["Edit"].firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap()
        XCTAssertTrue(app.buttons["Split"].waitForExistence(timeout: 15))
        sleep(3)

        let timeline = app.descendants(matching: .any)["editor-timeline"].firstMatch
        XCTAssertTrue(timeline.exists)
        let length = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Edited length'")).firstMatch
        XCTAssertTrue(length.exists)
        let original = length.label

        // Select the only clip so its handles show.
        timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        sleep(1)
        save("94-editor-handles")

        // The end handle sits just past the clip's right edge. Drag it in by a third.
        let endHandle = timeline.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5)).withOffset(CGVector(dx: 5, dy: 0))
        endHandle.press(forDuration: 0.2, thenDragTo: timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.66, dy: 0.5)))
        sleep(1)
        save("95-editor-trimmed-end")
        let afterEnd = length.label
        XCTAssertNotEqual(afterEnd, original, "dragging the end handle should shorten the clip")

        // The start handle sits just before the clip's left edge. Drag it in.
        let startHandle = timeline.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: -5, dy: 0))
        startHandle.press(forDuration: 0.2, thenDragTo: timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)))
        sleep(1)
        save("96-editor-trimmed-start")
        XCTAssertNotEqual(length.label, afterEnd, "dragging the start handle should shorten the clip")
        XCTAssertTrue(app.buttons["Save"].isEnabled)
    }
}
