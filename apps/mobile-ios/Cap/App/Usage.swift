import CapKit
import SwiftUI
import UIKit

/// What people do in the app, as named events with a few plain values: no titles, links, ids or anything typed.
/// `Analytics` in CapKit batches them and sends them to Cap.
enum Usage {
    static func track(_ name: String, _ properties: [String: AnalyticsValue] = [:]) {
        AppServices.shared.analytics.track(name, properties)
    }

    static func screen(_ name: String, _ properties: [String: AnalyticsValue] = [:]) {
        track("screen_view", properties.merging(["screen": .string(name)]) { _, screen in screen })
    }

    @MainActor
    static func start() {
        let center = NotificationCenter.default
        // A launch posts the first of these too. A launch that only finishes an upload in the background posts
        // neither, and it is not someone opening Cap.
        for name in [UIApplication.willEnterForegroundNotification, UIApplication.didBecomeActiveNotification] {
            center.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { opened() }
            }
        }
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                isOpen = false
                // iOS may suspend Cap at any moment after this; the queue is sent, or saved, before it does.
                let assertion = BackgroundAssertion()
                assertion.begin {}
                Task {
                    await AppServices.shared.analytics.flush()
                    assertion.end()
                }
            }
        }
    }

    @MainActor private static var isOpen = false

    /// Once per visit: Control Centre, a permission prompt or Face ID make Cap active again without it having left.
    @MainActor
    private static func opened() {
        guard !isOpen else { return }
        isOpen = true
        track("app_opened", ["signed_in": .bool(AppServices.shared.vault.credentials != nil)])
    }
}

extension View {
    func usageScreen(_ name: String) -> some View {
        onAppear { Usage.screen(name) }
    }
}
