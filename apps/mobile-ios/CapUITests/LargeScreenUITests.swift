import XCTest

/// The open iPhone Duo shows the library beside the open Cap. Runs against the same fixture as CapUITests
/// (`CAP_FIXTURE_URL`) and skips on a phone, where CapUITests covers the single stack.
@MainActor
final class LargeScreenUITests: XCTestCase {
    private static let key = "0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e"
    private static let walkthrough = "Walkthrough: the new Cap 0.6.2 editor"

    private func launch(route: String? = nil) throws -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["CAP_API_BASE_URL"] = ProcessInfo.processInfo.environment["CAP_FIXTURE_URL"] ?? "http://localhost:4310"
        app.launchEnvironment["CAP_DEBUG_SESSION"] = "\(Self.key):user_richie"
        if let route { app.launchEnvironment["CAP_DEBUG_ROUTE"] = route }
        app.launch()
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 10))
        try XCTSkipUnless(min(window.frame.width, window.frame.height) >= 600, "Needs a large screen such as the open iPhone Duo")
        return app
    }

    private func rows(_ app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(identifier: "cap-row")
    }

    func testCapOpensBesideLibrary() throws {
        let app = try launch()
        XCTAssertTrue(app.staticTexts["Pick a Cap"].waitForExistence(timeout: 15))
        let first = rows(app).matching(NSPredicate(format: "label CONTAINS %@", Self.walkthrough)).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        first.tap()

        XCTAssertTrue(app.segmentedControls.firstMatch.waitForExistence(timeout: 15))
        let titles = app.staticTexts.matching(identifier: Self.walkthrough)
        XCTAssertTrue(titles.firstMatch.waitForExistence(timeout: 5), "The Cap's title shows in the detail column")
        XCTAssertFalse(app.staticTexts["Pick a Cap"].exists)
        XCTAssertTrue(first.isHittable, "The library stays on screen")
        XCTAssertTrue(first.isSelected)
        XCTAssertTrue(app.buttons["Settings"].firstMatch.isHittable, "The tab bar stays while a Cap is open")
        let libraryEdge = first.frame.maxX
        func shownInDetail() -> Bool { titles.allElementsBoundByIndex.contains { $0.frame.minX > libraryEdge } }
        XCTAssertTrue(shownInDetail(), "The Cap sits to the right of the library")

        let second = rows(app).element(boundBy: 1)
        XCTAssertTrue(second.exists)
        second.tap()
        XCTAssertTrue(second.waitForSelection(timeout: 5))
        XCTAssertFalse(first.isSelected)
        let moved = (0..<10).contains { _ in
            if !shownInDetail() { return true }
            usleep(300_000)
            return false
        }
        XCTAssertTrue(moved, "The detail column moved to the second Cap")
    }

    func testDeletingOpenCapClosesIt() throws {
        let app = try launch()
        let row = rows(app).matching(NSPredicate(format: "label CONTAINS %@", Self.walkthrough)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        XCTAssertTrue(app.segmentedControls.firstMatch.waitForExistence(timeout: 15))

        app.buttons["More"].firstMatch.tap()
        let delete = app.buttons["Delete"].firstMatch
        XCTAssertTrue(delete.waitForExistence(timeout: 5))
        delete.tap()
        let confirm = app.buttons["Delete Cap"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()

        XCTAssertTrue(app.staticTexts["Pick a Cap"].waitForExistence(timeout: 10), "The deleted Cap leaves the detail column")
        XCTAssertFalse(app.segmentedControls.firstMatch.exists)
    }

    func testLinkOpensInDetailColumn() throws {
        let app = try launch(route: "cap:cap_stress?t=12")
        XCTAssertTrue(app.segmentedControls.firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(rows(app).firstMatch.waitForExistence(timeout: 10), "The library shows beside a Cap opened from a link")
        XCTAssertFalse(app.staticTexts["Pick a Cap"].exists)
        XCTAssertFalse(app.navigationBars.buttons["Back"].exists)
    }

    func testSettingsKeepReadableWidth() throws {
        let app = try launch(route: "tab:settings")
        let notifications = app.buttons["Notifications"].firstMatch
        XCTAssertTrue(notifications.waitForExistence(timeout: 15))
        let window = app.windows.firstMatch.frame
        XCTAssertLessThanOrEqual(notifications.frame.width, 640)
        XCTAssertGreaterThan(notifications.frame.minX, 100, "The form is centred, not pinned to the edge")
        XCTAssertGreaterThan(window.maxX - notifications.frame.maxX, notifications.frame.minX, "The right margin also clears the system rail")
    }
}

private extension XCUIElement {
    func waitForSelection(timeout: TimeInterval) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isSelected == true"), object: self)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }
}
