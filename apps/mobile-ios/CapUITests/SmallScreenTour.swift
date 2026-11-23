import XCTest

/// Screens and keyboard states the other UI tests don't photograph, for checking layouts on small phones.
@MainActor
final class SmallScreenTour: XCTestCase {
    private static let key = "0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e"

    private var fixtureURL: String {
        ProcessInfo.processInfo.environment["CAP_FIXTURE_URL"] ?? "http://localhost:4310"
    }

    private func launch(route: String? = nil, signedOut: Bool = false) -> XCUIApplication {
        continueAfterFailure = true
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

    func testSignInTyping() {
        let app = launch(signedOut: true)
        let email = app.textFields["Email address"]
        XCTAssertTrue(email.waitForExistence(timeout: 20))
        sleep(4)
        shot("t01-sign-in")
        email.tap()
        email.typeText("richie@cap.so")
        sleep(1)
        shot("t02-sign-in-typing")
        app.buttons["Continue with email"].tap()
        XCTAssertTrue(app.staticTexts["Check your email"].waitForExistence(timeout: 10))
        sleep(1)
        shot("t03-code")
        app.typeText("12")
        shot("t04-code-typing")
    }

    func testRecorderModes() {
        let app = launch()
        let tab = app.tabBars.buttons["Record"]
        XCTAssertTrue(tab.waitForExistence(timeout: 20))
        sleep(2)
        tab.tap()
        XCTAssertTrue(app.buttons["Close"].waitForExistence(timeout: 10))
        sleep(2)
        shot("t10-record-camera")
        for (mode, name) in [("Screen", "t11-record-screen"), ("Screen + Camera", "t12-record-screen-camera")] {
            let button = app.buttons[mode]
            if button.waitForExistence(timeout: 5) {
                button.tap()
                let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
                if allow.waitForExistence(timeout: 3) { allow.tap() }
                sleep(2)
                shot(name)
            }
        }
    }

    func testAddMenuAndCapComposer() {
        var app = launch()
        XCTAssertTrue(app.buttons["My Caps"].waitForExistence(timeout: 20))
        sleep(2)
        app.navigationBars.buttons["Add"].firstMatch.tap()
        sleep(2)
        shot("t20-add-menu")
        app.terminate()

        app = launch(route: "cap:cap_london?t=20")
        let comments = app.segmentedControls.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Comments'")).firstMatch
        XCTAssertTrue(comments.waitForExistence(timeout: 20))
        sleep(3)
        shot("t21-cap")
        app.swipeUp()
        sleep(1)
        shot("t22-cap-scrolled")
        let field = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        field.tap()
        sleep(1)
        shot("t23-cap-composing")
        field.typeText("Love this part, the new handles feel so much better")
        sleep(1)
        shot("t24-cap-composing-typed")
    }

    func testReplying() {
        let app = launch(route: "cap:cap_london?t=20")
        let comments = app.segmentedControls.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Comments'")).firstMatch
        XCTAssertTrue(comments.waitForExistence(timeout: 20))
        sleep(2)
        app.swipeUp()
        sleep(1)
        let replies = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reply to'"))
        guard let reply = replies.allElementsBoundByIndex.last(where: { $0.isHittable }) else {
            XCTFail("No visible Reply button")
            return
        }
        reply.tap()
        sleep(2)
        shot("t25-cap-replying")
        app.typeText("Fixed in the next build")
        sleep(1)
        shot("t26-cap-replying-typed")
    }

    func testTranscriptSearch() {
        let app = launch(route: "cap:cap_london?t=20")
        let transcript = app.segmentedControls.buttons["Transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 20))
        transcript.tap()
        let search = app.textFields["Search transcript"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        sleep(1)
        shot("t30-transcript")
        search.tap()
        search.typeText("editor")
        sleep(1)
        shot("t31-transcript-search")
    }
}
