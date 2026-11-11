import XCTest

/// Raw App Store screenshots. Run against the fixture in showcase mode (`CAP_FIXTURE_SHOWCASE=1`) on the 6.9"
/// simulator; each test saves one full-resolution PNG to `CAP_SHOT_DIR`.
final class AppStoreScreenshots: XCTestCase {
    private static let key = "0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e"

    private var fixtureURL: String {
        ProcessInfo.processInfo.environment["CAP_FIXTURE_URL"] ?? "http://localhost:4311"
    }

    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(route: String? = nil, signedOut: Bool = false) -> XCUIApplication {
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

    private func save(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let directory = ProcessInfo.processInfo.environment["CAP_SHOT_DIR"] else { return }
        try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
    }

    private func tapTab(_ app: XCUIApplication, _ label: String) {
        let tab = app.tabBars.buttons[label]
        XCTAssertTrue(tab.waitForExistence(timeout: 20))
        let hittable = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: tab)
        wait(for: [hittable], timeout: 10)
        tab.tap()
    }

    func test1Library() {
        let app = launch()
        XCTAssertTrue(app.buttons["My Caps"].waitForExistence(timeout: 20))
        sleep(4)
        save("01-library")
    }

    func test2Watch() {
        let app = launch(route: "cap:cap_london?t=42")
        XCTAssertTrue(app.staticTexts["Product update: the new editor"].waitForExistence(timeout: 20))
        // Playing, so the controls fade and the frame and captions show.
        sleep(7)
        save("02-watch")
    }

    func test3Record() {
        let app = launch()
        tapTab(app, "Record")
        let screen = app.buttons["Screen"]
        XCTAssertTrue(screen.waitForExistence(timeout: 10))
        screen.tap()
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
        if allow.waitForExistence(timeout: 4) { allow.tap() }
        sleep(3)
        save("03-record-screen")
    }

    func test4Add() {
        let app = launch()
        XCTAssertTrue(app.buttons["My Caps"].waitForExistence(timeout: 20))
        sleep(3)
        app.navigationBars.buttons["Add"].firstMatch.tap()
        sleep(2)
        save("04-add")
    }

    func test5Analytics() {
        let app = launch(route: "tab:analytics")
        sleep(6)
        save("05-analytics")
    }

    func test6Spaces() {
        let app = launch()
        let design = app.buttons["Design"]
        XCTAssertTrue(design.waitForExistence(timeout: 20))
        design.tap()
        sleep(4)
        save("06-spaces")
    }

    func test8Summary() {
        let app = launch(route: "cap:cap_london?t=20")
        XCTAssertTrue(app.staticTexts["Product update: the new editor"].waitForExistence(timeout: 20))
        let summary = app.buttons["Summary"].firstMatch
        XCTAssertTrue(summary.waitForExistence(timeout: 10))
        summary.tap()
        sleep(7)
        save("08-summary")
    }

    func test9Editor() {
        let app = launch(route: "cap:cap_london")
        let more = app.buttons["More"].firstMatch
        XCTAssertTrue(more.waitForExistence(timeout: 20))
        more.tap()
        let edit = app.buttons["Edit"].firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap()
        let split = app.buttons["Split"]
        XCTAssertTrue(split.waitForExistence(timeout: 15))
        sleep(3)
        let timeline = app.descendants(matching: .any)["editor-timeline"].firstMatch
        timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.42, dy: 0.5)).tap()
        sleep(1)
        split.tap()
        sleep(1)
        timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: 0.5)).tap()
        sleep(3)
        save("09-editor")
    }

    func test7SignIn() {
        _ = launch(signedOut: true)
        sleep(7)
        save("07-sign-in")
    }
}
