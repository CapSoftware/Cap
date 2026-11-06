import StoreKit
import SwiftUI

/// Whether Cap may point people to cap.so to upgrade. App Review 3.1.1(a) and 3.1.3 allow buttons and links to
/// purchases outside the App Store only on the United States storefront; everywhere else the app shows the plan
/// but never a way to buy it. Hidden until the storefront is known.
@MainActor @Observable
final class WebUpgrade {
    static let shared = WebUpgrade()

    private(set) var isAllowed = false
    private var watching: Task<Void, Never>?

    private static func allows(_ countryCode: String?) -> Bool { countryCode == "USA" }

    func start() {
        guard watching == nil else { return }
        #if DEBUG
        if let forced = ProcessInfo.processInfo.environment["CAP_DEBUG_STOREFRONT"] {
            isAllowed = Self.allows(forced)
            return
        }
        #endif
        watching = Task { [weak self] in
            let current = await Storefront.current
            self?.isAllowed = Self.allows(current?.countryCode)
            for await storefront in Storefront.updates {
                self?.isAllowed = Self.allows(storefront.countryCode)
            }
        }
    }
}
