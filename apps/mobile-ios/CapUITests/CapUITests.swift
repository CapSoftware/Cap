import XCTest

/// Drives the app against the local fixture API (see README) and saves screenshots for review.
/// Needs CAP_FIXTURE_URL; screenshots go to CAP_SHOT_DIR when set.
@MainActor
final class CapUITests: XCTestCase {
    private static let key = "0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e"
    private static let emptyKey = "1f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e"

    private var fixtureURL: String {
        ProcessInfo.processInfo.environment["CAP_FIXTURE_URL"] ?? "http://localhost:4310"
    }

    private func launch(route: String? = nil, key: String? = CapUITests.key, user: String = "user_richie") -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["CAP_API_BASE_URL"] = fixtureURL
        if let key {
            app.launchEnvironment["CAP_DEBUG_SESSION"] = "\(key):\(user)"
        } else {
            app.launchEnvironment["CAP_DEBUG_SIGNED_OUT"] = "1"
        }
        if let route { app.launchEnvironment["CAP_DEBUG_ROUTE"] = route }
        app.launch()
        return app
    }

    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let directory = ProcessInfo.processInfo.environment["CAP_SHOT_DIR"] else { return }
        let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
        try? screenshot.pngRepresentation.write(to: url)
    }

    private func waitFor(_ element: XCUIElement, _ timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) {
        let found = element.waitForExistence(timeout: timeout)
        if !found { shot("FAIL-\(name.split(separator: " ").last?.dropLast() ?? "test")-line\(line)") }
        XCTAssertTrue(found, "Missing \(element)", file: file, line: line)
    }

    private func composer(_ app: XCUIApplication) -> XCUIElement {
        let view = app.textViews.firstMatch
        return view.exists ? view : app.textFields.matching(NSPredicate(format: "placeholderValue BEGINSWITH 'Respond' OR placeholderValue BEGINSWITH 'Add a comment' OR placeholderValue BEGINSWITH 'Reply'")).firstMatch
    }

    private func section(_ app: XCUIApplication, _ prefix: String) -> XCUIElement {
        app.segmentedControls.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    func testSignIn() {
        let app = launch(key: nil)
        let email = app.textFields["Email address"]
        waitFor(email)
        shot("01-sign-in")
        email.tap()
        email.typeText("richie@cap.so")
        app.buttons["Continue with email"].tap()
        waitFor(app.staticTexts["Check your email"])
        shot("02-sign-in-code")
        app.typeText("123456")
        waitFor(app.navigationBars.firstMatch, 15)
        waitFor(app.buttons["Caps"], 15)
        shot("03-signed-in-home")
    }

    func testLibrary() {
        let app = launch()
        waitFor(app.staticTexts["Walkthrough: the new Cap 0.6.2 editor"], 15)
        shot("10-home")
        app.swipeUp()
        app.swipeUp()
        shot("11-home-scrolled")
    }

    func testStressSharePage() {
        let app = launch(route: "cap:cap_stress")
        let comments = section(app, "Comments")
        waitFor(comments, 15)
        shot("20-stress-top")

        app.buttons["React with 😂"].tap()
        app.buttons["React with 😍"].tap()
        shot("21-stress-reacted")

        let field = composer(app)
        waitFor(field)
        field.tap()
        field.typeText("A comment from the UI test with an emoji 🎬 and a link https://cap.so")
        shot("22-stress-composing")
        app.buttons["Send comment"].tap()
        waitFor(app.staticTexts["A comment from the UI test with an emoji 🎬 and a link https://cap.so"], 10)

        let replies = app.buttons.matching(identifier: "Reply to Richie McIlroy")
        waitFor(replies.firstMatch)
        let window = app.windows.firstMatch.frame
        // The pinned section picker covers the top of the scroll view, so check hittability as well.
        let reply = replies.allElementsBoundByIndex.first { window.insetBy(dx: 0, dy: 120).contains($0.frame) && $0.isHittable }
        XCTAssertNotNil(reply, "No visible Reply button for the new comment")
        reply?.tap()
        waitFor(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Replying to'")).firstMatch)
        composer(app).typeText("Replying from the test")
        shot("23-stress-replying")
        app.buttons["Send reply"].tap()
        waitFor(app.staticTexts["Replying from the test"], 10)

        app.swipeUp()
        app.swipeUp()
        shot("24-stress-comments-scrolled")
        app.swipeUp()
        app.swipeUp()
        app.swipeUp()
        shot("25-stress-comments-deep")
    }

    func testTranscriptSummaryAndCaptions() {
        let app = launch(route: "cap:cap_stress?t=12")
        let transcript = section(app, "Transcript")
        waitFor(transcript, 15)
        transcript.tap()
        let search = app.textFields["Search transcript"]
        waitFor(search)
        shot("30-transcript")
        search.tap()
        search.typeText("billing")
        shot("31-transcript-search")
        app.buttons["Clear search"].tap()
        section(app, "Summary").tap()
        shot("32-summary")
        app.swipeUp()
        shot("33-summary-chapters")
        sleep(3)
        shot("34-captions-playing")
        if app.buttons["Hide captions"].waitForExistence(timeout: 3) || app.otherElements["Video"].exists {
            // Paused controls don't fade, so the toggles below can't race the auto-hide.
            tapPlayerControl(app, "Pause")
            tapPlayerControl(app, "Hide captions")
            shot("35-captions-off")
            tapPlayerControl(app, "Show captions")
        }
    }

    /// Player controls fade while playing, so reveal the one we want and tap it straight away.
    private func tapPlayerControl(_ app: XCUIApplication, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let button = app.buttons[label]
        for _ in 0..<5 {
            if button.exists, button.isHittable {
                button.tap()
                return
            }
            app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.25)).tap()
            _ = button.waitForExistence(timeout: 1.5)
        }
        shot("FAIL-control-\(label)")
        XCTFail("Couldn't reach \(label)", file: file, line: line)
    }

    private func showPlayerControls(_ app: XCUIApplication) {
        let video = app.otherElements["Video"].firstMatch
        guard video.waitForExistence(timeout: 5) else { return }
        for _ in 0..<4 {
            let button = app.buttons["Full screen"]
            if button.exists, button.isHittable { return }
            video.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.3)).tap()
            _ = button.waitForExistence(timeout: 1)
        }
    }

    func testCustomPlayer() {
        let app = launch(route: "cap:cap_stress?t=6")
        waitFor(section(app, "Comments"), 15)
        showPlayerControls(app)
        waitFor(app.buttons["Full screen"])
        shot("84-player-controls")
        app.buttons["Pause"].firstMatch.tap()
        let speed = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Playback speed'")).firstMatch
        if speed.exists {
            speed.tap()
            shot("85-speed-menu")
            let option = app.buttons["1.5×"].exists ? app.buttons["1.5×"] : app.collectionViews.buttons["1.5×"]
            if option.waitForExistence(timeout: 3) { option.tap() }
        }
        let position = app.otherElements["Playback position"].firstMatch
        if position.exists {
            let start = position.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5))
            start.press(forDuration: 0.3, thenDragTo: position.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5)))
        }
        shot("86-after-scrub")
    }

    /// The upgrade link only exists on the United States storefront (App Review 3.1.1(a)), and only on the free plan.
    func testUpgradeOnlyOnUSStorefront() {
        for (storefront, expected) in [("USA", true), ("GBR", false)] {
            let app = XCUIApplication()
            app.launchEnvironment["CAP_API_BASE_URL"] = fixtureURL
            app.launchEnvironment["CAP_DEBUG_SESSION"] = "\(CapUITests.emptyKey):user_empty"
            app.launchEnvironment["CAP_DEBUG_ROUTE"] = "tab:settings"
            app.launchEnvironment["CAP_DEBUG_STOREFRONT"] = storefront
            app.launch()
            waitFor(app.staticTexts["Free"], 15)
            XCTAssertEqual(app.buttons["Upgrade to Cap Pro"].exists, expected, storefront)
            app.swipeUp()
            XCTAssertTrue(app.buttons["View the Cap dashboard"].waitForExistence(timeout: 3), storefront)
            shot("73-upgrade-\(storefront)")
            app.terminate()
        }
        let pro = XCUIApplication()
        pro.launchEnvironment["CAP_API_BASE_URL"] = fixtureURL
        pro.launchEnvironment["CAP_DEBUG_SESSION"] = "\(CapUITests.key):user_richie"
        pro.launchEnvironment["CAP_DEBUG_ROUTE"] = "tab:settings"
        pro.launchEnvironment["CAP_DEBUG_STOREFRONT"] = "USA"
        pro.launch()
        waitFor(pro.staticTexts["Cap Pro"], 15)
        XCTAssertFalse(pro.buttons["Upgrade to Cap Pro"].exists)
    }

    /// Free plans see the 5 minute limit on the recorder everywhere; only the United States storefront gets a link to upgrade.
    func testFreeLimitNote() {
        let note = "Free plan recordings stop at 5 minutes. Cap Pro has no limit."
        for (key, user, storefront, showsNote, showsLink) in [
            (CapUITests.emptyKey, "user_empty", "USA", true, true),
            (CapUITests.emptyKey, "user_empty", "GBR", true, false),
            (CapUITests.key, "user_richie", "USA", false, false),
        ] {
            let app = XCUIApplication()
            app.launchEnvironment["CAP_API_BASE_URL"] = fixtureURL
            app.launchEnvironment["CAP_DEBUG_SESSION"] = "\(key):\(user)"
            app.launchEnvironment["CAP_DEBUG_STOREFRONT"] = storefront
            app.launch()
            let tab = app.tabBars.buttons["Record"]
            waitFor(tab, 20)
            let hittable = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: tab)
            wait(for: [hittable], timeout: 10)
            tab.tap()
            waitFor(app.buttons["Close"], 10)
            sleep(3)
            XCTAssertEqual(app.staticTexts[note].exists, showsNote, "\(user) \(storefront)")
            XCTAssertEqual(app.buttons["Upgrade in your Cap dashboard"].exists, showsLink, "\(user) \(storefront)")
            shot("74-record-\(user)-\(storefront)")
            app.terminate()
        }
    }

    func testCaptureModes() {
        let app = launch()
        let tab = app.tabBars.buttons["Record"]
        waitFor(tab, 20)
        let hittable = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: tab)
        wait(for: [hittable], timeout: 10)
        tab.tap()
        waitFor(app.buttons["Close"], 10)
        waitFor(app.staticTexts["Instant Mode"], 10)
        shot("75-record-modes")
        for mode in ["Studio Mode", "Screenshot Mode"] {
            let button = app.buttons[mode]
            waitFor(button, 10)
            XCTAssertEqual(button.value as? String, "Coming soon")
            button.tap()
            waitFor(app.staticTexts["\(mode) is coming soon"], 5)
            shot("75-record-\(mode.split(separator: " ")[0].lowercased())-soon")
            waitFor(app.staticTexts["Instant Mode"], 10)
        }
    }

    func testLinkAccessSwitch() {
        let app = launch(route: "cap:cap_link")
        let more = app.buttons["More"].firstMatch
        let open = app.buttons["Open to anyone with the link"].firstMatch
        let limit = app.buttons["Limit to your organization"].firstMatch
        waitFor(more, 15)
        more.tap()
        waitFor(open)
        XCTAssertFalse(limit.exists)
        shot("90-link-restricted-menu")
        open.tap()
        waitFor(more)
        more.tap()
        waitFor(limit)
        XCTAssertFalse(open.exists)
        shot("91-link-open-menu")
        limit.tap()
        waitFor(more)
        more.tap()
        waitFor(open)
        app.buttons["Make private"].firstMatch.tap()
        waitFor(more)
        more.tap()
        waitFor(app.buttons["Make public"].firstMatch)
        XCTAssertFalse(open.exists)
        XCTAssertFalse(limit.exists)
        shot("92-link-private-menu")
        app.buttons["Make public"].firstMatch.tap()
        waitFor(more)
        more.tap()
        waitFor(open)
        XCTAssertFalse(limit.exists)
    }

    func testScopeBar() {
        let app = launch()
        let myCaps = app.buttons["My Caps"]
        waitFor(myCaps, 15)
        XCTAssertTrue(app.buttons["Design"].exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Organization, '")).firstMatch.exists)
        shot("20-scope-bar")
        app.buttons["Design"].tap()
        waitFor(app.navigationBars["Design"])
        shot("21-scope-space")
        app.buttons["Engineering"].tap()
        waitFor(app.navigationBars["Engineering"])
        // In the iPhone Duo's narrow library column the chips scroll; bring My Caps back before tapping it.
        let origin = app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
        for _ in 0..<3 where myCaps.frame.minX < 0 {
            let y = myCaps.frame.midY
            origin.withOffset(CGVector(dx: 40, dy: y)).press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: 300, dy: y)))
        }
        myCaps.tap()
        waitFor(app.navigationBars["My Caps"])
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Organization, '")).firstMatch.tap()
        shot("22-organization-menu")
    }

    /// A picked speed carries to the next Cap after a relaunch. On a fresh install the first Cap starts at 1x even though
    /// the fixture suggests 1.2x; other tests change the speed, so that part only holds when this runs first.
    func testPlaybackSpeedRemembered() {
        var app = launch(route: "cap:cap_stress?t=6")
        waitFor(section(app, "Comments"), 15)
        showPlayerControls(app)
        app.buttons["Pause"].firstMatch.tap()
        let speed = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Playback speed'")).firstMatch
        waitFor(speed)
        XCTAssertNotEqual(speed.label, "Playback speed 1.2×")
        let pick = speed.label == "Playback speed 1.75×" ? "0.75×" : "1.75×"
        speed.tap()
        shot("87-speed-menu")
        let option = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", pick)).firstMatch
        waitFor(option, 3)
        option.tap()
        app.terminate()

        app = launch(route: "cap:cap_rtl?t=6")
        waitFor(section(app, "Comments"), 15)
        showPlayerControls(app)
        let remembered = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Playback speed'")).firstMatch
        waitFor(remembered)
        XCTAssertEqual(remembered.label, "Playback speed \(pick)")
        shot("88-speed-remembered")
    }

    func testFullscreenRotation() {
        let app = launch(route: "cap:cap_stress")
        waitFor(section(app, "Comments"), 15)
        sleep(1)
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        shot("80-inline-rotated-stays-portrait")
        XCUIDevice.shared.orientation = .portrait
        sleep(1)
        // Starts paused, so the controls stay up and taps can't race the auto-hide.
        tapPlayerControl(app, "Full screen")
        waitFor(app.buttons["Close full screen"], 5)
        shot("81-fullscreen-portrait")
        sleep(2)
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        shot("82-fullscreen-landscape")
        tapPlayerControl(app, "Close full screen")
        waitFor(section(app, "Comments"), 5)
        XCUIDevice.shared.orientation = .portrait
        sleep(2)
        shot("83-after-fullscreen")
    }

    func testPasswordGate() {
        let app = launch(route: "cap:cap_locked")
        let field = app.secureTextFields["Password"]
        waitFor(field, 15)
        shot("40-locked")
        field.tap()
        field.typeText("wrong")
        app.buttons["Watch Cap"].tap()
        waitFor(app.staticTexts["Error: That password didn't work."].exists ? app.staticTexts["Error: That password didn't work."] : app.otherElements["Error: That password didn't work."], 10)
        shot("41-locked-wrong")
        field.tap()
        field.press(forDuration: 1.2)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        field.typeText(XCUIKeyboardKey.delete.rawValue)
        field.typeText("letmein")
        app.buttons["Watch Cap"].tap()
        waitFor(section(app, "Comments"), 15)
        shot("42-unlocked")
    }

    func testEdgeCaseCaps() {
        for (id, name) in [("cap_restricted", "50-restricted"), ("cap_quiet", "51-quiet"), ("cap_shot", "52-screenshot"), ("cap_limit", "53-over-limit"), ("cap_rtl", "54-rtl"), ("cap_miami", "55-processing"), ("cap_missing", "56-missing")] {
            let app = launch(route: "cap:\(id)")
            sleep(4)
            shot(name)
            app.terminate()
        }
    }

    func testSettingsAndAnalytics() {
        var app = launch(route: "tab:analytics")
        sleep(4)
        shot("60-analytics")
        app.swipeUp()
        shot("61-analytics-scrolled")
        app.terminate()
        app = launch(route: "tab:settings")
        sleep(3)
        shot("62-settings")
        app.terminate()
        app = launch(route: "settings:organization")
        sleep(3)
        shot("63-organization")
        app.terminate()
        app = launch(route: "settings:profile")
        sleep(3)
        shot("64-profile")
        app.terminate()
        app = launch(route: "analytics:cap_london")
        sleep(4)
        shot("65-cap-analytics")
    }

    func testNotificationSettings() {
        var app = launch(route: "tab:settings")
        let link = app.buttons["Notifications"].firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 15))
        link.tap()
        let views = app.switches.matching(NSPredicate(format: "label BEGINSWITH 'Views'")).firstMatch
        let reactions = app.switches.matching(NSPredicate(format: "label BEGINSWITH 'Reactions'")).firstMatch
        XCTAssertTrue(views.waitForExistence(timeout: 10))
        XCTAssertEqual(views.value as? String, "1")
        XCTAssertEqual(reactions.value as? String, "1")

        // Two quick changes both reach the server and neither flips back.
        views.switches.firstMatch.tap()
        reactions.switches.firstMatch.tap()
        XCTAssertTrue(waitForServerNotifications(["views": false, "reactions": false]))
        XCTAssertEqual(views.value as? String, "0")
        XCTAssertEqual(reactions.value as? String, "0")
        shot("66-notifications")
        app.terminate()

        app = launch(route: "tab:settings")
        XCTAssertTrue(app.buttons["Notifications"].firstMatch.waitForExistence(timeout: 15))
        app.buttons["Notifications"].firstMatch.tap()
        let savedViews = app.switches.matching(NSPredicate(format: "label BEGINSWITH 'Views'")).firstMatch
        let savedReactions = app.switches.matching(NSPredicate(format: "label BEGINSWITH 'Reactions'")).firstMatch
        XCTAssertTrue(savedViews.waitForExistence(timeout: 10))
        XCTAssertEqual(savedViews.value as? String, "0")
        XCTAssertEqual(savedReactions.value as? String, "0")
        savedViews.switches.firstMatch.tap()
        savedReactions.switches.firstMatch.tap()
        XCTAssertTrue(waitForServerNotifications(["views": true, "reactions": true]))
    }

    /// Needs a fresh install (no notification permission yet) and a simulator that can reach APNs.
    func testPushNotificationsRegister() {
        let app = launch(route: "tab:settings")
        let link = app.buttons["Notifications"].firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 15))
        link.tap()
        let turnOn = app.buttons["Turn on push notifications"]
        XCTAssertTrue(turnOn.waitForExistence(timeout: 10))
        shot("67-push-off")
        var request = URLRequest(url: URL(string: "\(fixtureURL)/fixture/push-tokens")!)
        request.setValue("Bearer \(CapUITests.key)", forHTTPHeaderField: "Authorization")
        let before = Set(fetchObject(request).keys)
        turnOn.tap()

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 10))
        allow.tap()

        XCTAssertTrue(app.staticTexts["Push notifications are on"].waitForExistence(timeout: 10))
        shot("68-push-on")
        let deadline = Date().addingTimeInterval(30)
        var added: [String: Any] = [:]
        repeat {
            added = fetchObject(request).filter { !before.contains($0.key) }
            if !added.isEmpty { break }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        XCTAssertEqual(added.values.compactMap { $0 as? String }, ["sandbox"], "the app should register one new sandbox token")
    }

    /// Manual end-to-end check: a real APNs push sent to the registered token while this waits
    /// (CAP_PUSH_E2E=1) must show a banner, and tapping it must open that Cap.
    func testTappingPushOpensCap() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CAP_PUSH_E2E"] == "1", "needs a push sent from outside the test")
        let app = launch(route: "tab:settings")
        XCTAssertTrue(app.buttons["Notifications"].firstMatch.waitForExistence(timeout: 15))
        app.buttons["Notifications"].firstMatch.tap()
        let turnOn = app.buttons["Turn on push notifications"]
        if turnOn.waitForExistence(timeout: 5) {
            turnOn.tap()
            let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
            XCTAssertTrue(allow.waitForExistence(timeout: 10))
            allow.tap()
        }
        XCTAssertTrue(app.staticTexts["Push notifications are on"].waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home)

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let banner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Love the new editor'")).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 120), "the push banner should appear")
        shot("69-push-banner")
        banner.tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        XCTAssertTrue(app.buttons["More"].firstMatch.waitForExistence(timeout: 15), "tapping the push should open the Cap")
        shot("70-push-opened-cap")
    }

    private func waitForServerNotifications(_ expected: [String: Bool], timeout: TimeInterval = 10) -> Bool {
        var request = URLRequest(url: URL(string: "\(fixtureURL)/api/mobile/user/notification-preferences")!)
        request.setValue("Bearer \(CapUITests.key)", forHTTPHeaderField: "Authorization")
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let current = fetchJSON(request)
            if expected.allSatisfy({ current[$0.key] == $0.value }) { return true }
            Thread.sleep(forTimeInterval: 0.2)
        } while Date() < deadline
        return false
    }

    private func fetchJSON(_ request: URLRequest) -> [String: Bool] {
        fetchObject(request).compactMapValues { $0 as? Bool }
    }

    private func fetchObject(_ request: URLRequest) -> [String: Any] {
        let done = DispatchSemaphore(value: 0)
        let box = JSONBox()
        URLSession.shared.dataTask(with: request) { data, _, _ in
            box.value = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            done.signal()
        }.resume()
        done.wait()
        return box.value
    }

    func testEmptyAccount() {
        var app = launch(key: CapUITests.emptyKey, user: "user_empty")
        sleep(4)
        shot("70-empty-home")
        app.terminate()
        app = launch(route: "tab:analytics", key: CapUITests.emptyKey, user: "user_empty")
        sleep(3)
        shot("71-empty-analytics")
        app.terminate()
        app = launch(route: "tab:settings", key: CapUITests.emptyKey, user: "user_empty")
        sleep(3)
        shot("72-empty-settings")
    }
}

private extension XCTNSPredicateExpectation {
    static func wait(for element: XCUIElement, value: String, timeout: TimeInterval = 5) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}

private final class JSONBox: @unchecked Sendable {
    var value: [String: Any] = [:]
}
