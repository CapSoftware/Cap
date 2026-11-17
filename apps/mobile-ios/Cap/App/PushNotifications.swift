import CapKit
import Observation
import OSLog
import UIKit
import UserNotifications

@MainActor
@Observable
final class PushNotifications {
    static let shared = PushNotifications()

    #if DEBUG
    static let environment = PushEnvironment.sandbox
    #else
    static let environment = PushEnvironment.production
    #endif

    private static let log = Logger(subsystem: "so.cap.mobile", category: "push")
    private static let tokenKey = "pushDeviceToken"
    private static let askedAfterUploadKey = "pushAskedAfterUpload"

    /// Set when a push is tapped before the main view is on screen; the main view opens it.
    var pendingCapId: CapID?
    private(set) var status: UNAuthorizationStatus = .notDetermined

    private var services: AppServices { .shared }

    func refreshStatus() async {
        status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    func registerIfAllowed() async {
        await refreshStatus()
        guard services.vault.credentials != nil, Self.allowsAlerts(status) else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    @discardableResult
    func requestAuthorization() async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await refreshStatus()
        if granted { UIApplication.shared.registerForRemoteNotifications() }
        return granted
    }

    /// Asks once, after the first upload: the point where someone could start watching.
    func askAfterFirstUpload() {
        let defaults = UserDefaults.standard
        // The prompt only shows in the foreground; an upload finishing in the background asks next time.
        guard UIApplication.shared.applicationState == .active, !defaults.bool(forKey: Self.askedAfterUploadKey) else { return }
        defaults.set(true, forKey: Self.askedAfterUploadKey)
        Task {
            await refreshStatus()
            guard status == .notDetermined else { return }
            await requestAuthorization()
        }
    }

    func didRegister(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: Self.tokenKey)
        guard services.vault.credentials != nil else { return }
        let api = services.api
        Task {
            do {
                try await api.registerPushToken(token, environment: Self.environment)
            } catch {
                Self.log.error("Couldn't register for push: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Runs before the session is revoked. Revoking deletes the token server-side too, and unregistering
    /// here invalidates it at APNs, so a sign-out that can't reach Cap still stops this phone's pushes.
    func unregister() async {
        let defaults = UserDefaults.standard
        if let token = defaults.string(forKey: Self.tokenKey) {
            try? await services.api.removePushToken(token)
            defaults.removeObject(forKey: Self.tokenKey)
        }
        UIApplication.shared.unregisterForRemoteNotifications()
    }

    func open(_ userInfo: [AnyHashable: Any]) -> Bool {
        guard let id = (userInfo["capId"] as? String).flatMap(CapID.init) else { return false }
        pendingCapId = id
        return true
    }

    static func allowsAlerts(_ status: UNAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .provisional, .ephemeral: true
        default: false
        }
    }
}
