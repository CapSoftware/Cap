import XCTest

/// Screens and keyboard states the other UI tests don't photograph, for checking layouts on small phones.
@MainActor
final class SmallScreenTour: XCTestCase {
    private static let key = "0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e"

    private var fixtureURL: String {
        ProcessInfo.processInfo.environment["CAP_FIXTURE_URL"] ?? "http://localhost:4310"
    }

    private func launch(route: String? = nil, signedOut: Bool = false) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["CAP_API_BASE_URL"] = fixtureURL
        app.launchEnvironment["CAP_DEBUG_STOREFRONT"] = "GBR"
        if signedOut {
            app.launchEnvironment["CAP_DEBUG_SIGNED_OUT"] = "1"
        } else {
            app.launchEnvironment["CAP_DEBUG_SESSION"] = "\(Self.key):user_richie"
        }
        if let route { app.launchEnvironment["CAP_DEBUG_ROUTE"] = route }
        app.launch()
        return app
    }

    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        guard let directory = ProcessInfo.processInfo.environment["CAP_SHOT_DIR"] else { return }
        try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
    }

    private func waitUntilHittable(_ element: XCUIElement, timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) {
        let hittable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND isHittable == true"), object: element)
        XCTAssertEqual(XCTWaiter().wait(for: [hittable], timeout: timeout), .completed, "\(element) never became hittable", file: file, line: line)
    }

    private func waitForKeyboard(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "No keyboard", file: file, line: line)
    }

    private func sectionButton(_ app: XCUIApplication, _ prefix: String) -> XCUIElement {
        app.segmentedControls.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    func testSignInTyping() {
        let app = launch(signedOut: true)
        let email = app.textFields["Email address"]
        waitUntilHittable(email, timeout: 20)
        email.tap()
        email.typeText("richie@cap.so")
        waitForKeyboard(app)
        waitUntilHittable(app.buttons["Continue with email"])
        shot("t02-sign-in-typing")
        app.buttons["Continue with email"].tap()
        XCTAssertTrue(app.staticTexts["Check your email"].waitForExistence(timeout: 10))
        waitForKeyboard(app)
        app.typeText("12")
        shot("t04-code-typing")
    }

    func testRecorderModes() {
        let app = launch()
        let tab = app.tabBars.buttons["Record"]
        waitUntilHittable(tab, timeout: 20)
        tab.tap()
        waitUntilHittable(app.buttons["Close"])
        shot("t10-record-camera")
        for (mode, title, name) in [
            ("Screen", "Record your screen", "t11-record-screen"),
            ("Screen + Camera", "Record your screen and camera", "t12-record-screen-camera"),
        ] {
            let button = app.buttons[mode]
            guard button.waitForExistence(timeout: 5) else { continue }
            button.tap()
            let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
            if allow.waitForExistence(timeout: 3) { allow.tap() }
            XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10))
            waitUntilHittable(app.buttons["Close"])
            shot(name)
        }
    }

    func testAddMenu() {
        let app = launch()
        let add = app.navigationBars.buttons["Add"].firstMatch
        waitUntilHittable(add, timeout: 20)
        add.tap()
        waitUntilHittable(app.buttons["Upload from Photos"].firstMatch)
        shot("t20-add-menu")
    }

    func testCapComposer() {
        let app = launch(route: "cap:cap_london?t=20")
        waitUntilHittable(sectionButton(app, "Comments"), timeout: 20)
        shot("t21-cap")
        let field = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        field.tap()
        waitForKeyboard(app)
        waitUntilHittable(sectionButton(app, "Comments"))
        field.typeText("Love this part, the new handles feel so much better")
        shot("t24-cap-composing-typed")
    }

    func testReplying() {
        let app = launch(route: "cap:cap_london?t=20")
        waitUntilHittable(sectionButton(app, "Comments"), timeout: 20)
        app.swipeUp()
        let replies = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reply to'"))
        guard let reply = replies.allElementsBoundByIndex.last(where: { $0.isHittable }) else {
            XCTFail("No visible Reply button")
            return
        }
        reply.tap()
        waitForKeyboard(app)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Replying to'")).firstMatch.waitForExistence(timeout: 5))
        app.typeText("Fixed in the next build")
        shot("t26-cap-replying-typed")
    }

    func testTranscriptSearch() {
        let app = launch(route: "cap:cap_london?t=20")
        let transcript = sectionButton(app, "Transcript")
        waitUntilHittable(transcript, timeout: 20)
        transcript.tap()
        let search = app.textFields["Search transcript"]
        waitUntilHittable(search)
        search.tap()
        search.typeText("editor")
        waitForKeyboard(app)
        let match = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'editor'")).firstMatch
        waitUntilHittable(match)
        shot("t31-transcript-search")
    }
}
