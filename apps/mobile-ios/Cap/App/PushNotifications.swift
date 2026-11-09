import CapKit
import Observation
import OSLog
import UIKit
import UserNotifications

/// Push notifications for comments, replies, reactions and views on the user's Caps.
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

    /// A Cap the user opened from a push, picked up by the main view once it's on screen.
    var pendingCapId: CapID?
    private(set) var status: UNAuthorizationStatus = .notDetermined

    private var services: AppServices { .shared }

    func refreshStatus() async {
        status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// Registers this install when the user already allows notifications. Safe to call on every launch and sign-in.
    func registerIfAllowed() async {
        await refreshStatus()
        guard services.vault.credentials != nil, Self.allowsAlerts(status) else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Shows the system prompt. Returns whether notifications are now allowed.
    @discardableResult
    func requestAuthorization() async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await refreshStatus()
        if granted { UIApplication.shared.registerForRemoteNotifications() }
        return granted
    }

    /// The first finished upload is when someone could start watching, so it's the moment to ask.
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

    /// Stops this phone getting the signed-in account's pushes. Runs before the session is revoked.
    func unregister() async {
        guard let token = UserDefaults.standard.string(forKey: Self.tokenKey) else { return }
        try? await services.api.removePushToken(token)
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
