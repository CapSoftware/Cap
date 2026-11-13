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

    private func openEditor() -> XCUIApplication {
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
        return app
    }

    func testSplitDeleteAndSave() throws {
        let app = openEditor()
        let split = app.buttons["Split"]
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

    /// On a large screen such as the open iPhone Duo the tools sit either side of the strip, leaving the picture more height.
    func testWideScreenToolsBesideTimeline() throws {
        let app = openEditor()
        let window = app.windows.firstMatch
        try XCTSkipUnless(min(window.frame.width, window.frame.height) >= 600, "Needs a large screen such as the open iPhone Duo")
        let timeline = app.descendants(matching: .any)["editor-timeline"].firstMatch
        XCTAssertTrue(timeline.exists)
        let undo = app.buttons["Undo"]
        let split = app.buttons["Split"]
        XCTAssertLessThan(abs(undo.frame.midY - timeline.frame.midY), 8)
        XCTAssertLessThan(undo.frame.maxX, timeline.frame.minX)
        XCTAssertGreaterThan(split.frame.minX, timeline.frame.maxX)
    }

    /// Each step is a touch the Photos trimmer was measured with, and has to end the same way here: the strip
    /// stays where it is, a handle follows 3.6 points inside the finger, and the playhead comes to rest on it.
    func testTrimHandlesFollowPhotos() throws {
        let app = openEditor()
        let timeline = app.descendants(matching: .any)["editor-timeline"].firstMatch
        XCTAssertTrue(timeline.exists)
        let frame = timeline.frame
        let left = frame.minX + 18
        let width = frame.width - 36

        func element(_ label: String) -> XCUIElement {
            app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
        }
        func seconds(_ label: String) -> Double {
            Double(((element(label).value as? String) ?? "").replacingOccurrences(of: " seconds", with: "")) ?? -1
        }
        func drag(from: CGFloat, to: CGFloat) {
            // Measured from the strip rather than the app: on the iPhone Duo's inner display the app's frame is in the
            // panel's portrait space while elements report the landscape interface.
            let origin = timeline.coordinate(withNormalizedOffset: .zero)
            origin.withOffset(CGVector(dx: from - frame.minX, dy: frame.height / 2))
                .press(forDuration: 0.1, thenDragTo: origin.withOffset(CGVector(dx: to - frame.minX, dy: frame.height / 2)), withVelocity: 200, thenHoldForDuration: 0)
            usleep(900_000)
        }

        let duration = seconds("Trim end")
        XCTAssertGreaterThan(duration, 1)
        func x(_ time: Double) -> CGFloat { left + CGFloat(time / duration) * width }
        func time(_ x: CGFloat) -> Double { Double((x - left) / width) * duration }
        let aPoint = duration / Double(width)
        XCTAssertEqual(element("Trim start").frame.minX, frame.minX, accuracy: 0.5)
        XCTAssertEqual(element("Trim end").frame.maxX, frame.maxX, accuracy: 0.5)
        save("94-editor-handles")

        // A touch that hasn't travelled 10 points does nothing.
        drag(from: x(duration) + 9, to: x(duration) + 1)
        XCTAssertEqual(seconds("Trim end"), duration, accuracy: 0.001)

        // The playhead starts against the start handle, and the handle still takes a touch that goes down on it.
        drag(from: left - 9, to: left + 30)
        XCTAssertEqual(seconds("Trim start"), time(left + 30 + 3.6), accuracy: aPoint)
        drag(from: x(seconds("Trim start")) - 9, to: frame.minX - 20)
        XCTAssertEqual(seconds("Trim start"), 0, accuracy: 0.001)

        // The end handle follows the finger and nothing else moves.
        let end = left + width * 0.68
        drag(from: x(duration) + 9, to: end)
        XCTAssertEqual(seconds("Trim end"), time(end - 3.6), accuracy: aPoint)
        XCTAssertEqual(seconds("Trim start"), 0, accuracy: 0.001)
        XCTAssertEqual(timeline.frame, frame)
        XCTAssertEqual(element("Trim start").frame.minX, frame.minX, accuracy: 0.5)
        XCTAssertEqual(element("Playhead").frame.maxX, element("Trim end").frame.minX, accuracy: 0.75)
        save("95-editor-trimmed-end")

        // Out of a handle's reach the strip scrubs: the playhead goes to the finger and the trim stays.
        let trimmedEnd = seconds("Trim end")
        drag(from: left + 70, to: left + 20)
        XCTAssertEqual(seconds("Trim end"), trimmedEnd, accuracy: 0.001)
        XCTAssertEqual(seconds("Trim start"), 0, accuracy: 0.001)
        XCTAssertEqual(element("Playhead").frame.midX, left + 20, accuracy: 0.75)

        // Within 50 points inside it, the handle takes the touch and jumps under the finger.
        drag(from: x(trimmedEnd) - 30, to: x(trimmedEnd) - 60)
        XCTAssertEqual(seconds("Trim end"), time(x(trimmedEnd) - 60 - 3.6), accuracy: aPoint)

        // The start handle, grabbed from the cut video outside it once it has moved in.
        drag(from: left - 9, to: left + 40)
        XCTAssertEqual(seconds("Trim start"), time(left + 40 + 3.6), accuracy: aPoint)
        drag(from: left + 5, to: left + 60)
        XCTAssertEqual(seconds("Trim start"), time(left + 60 + 3.6), accuracy: aPoint)
        XCTAssertEqual(element("Playhead").frame.minX, element("Trim start").frame.maxX, accuracy: 0.75)
        XCTAssertEqual(timeline.frame, frame)
        save("96-editor-trimmed-start")
        XCTAssertTrue(app.buttons["Save"].isEnabled)
    }
}
