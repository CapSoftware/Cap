import CapKit
import Foundation
import Observation
import os
import UIKit

nonisolated final class AppServices: Sendable {
    let environment: CapEnvironment
    let vault: CredentialVault
    let api: CapAPI
    let images: ImagePipeline
    let cache: DiskCache
    let uploads: UploadEngine
    let backgroundUploads: BackgroundUploads
    let recordings: RecordingUploads
    let screenRecordings: RecordingUploads?
    let analytics: Analytics
    let unauthorized: AsyncStream<CredentialSnapshot>
    /// True on the first launch after an install, when stale keychain items are wiped.
    let firstLaunch: Bool

    private static let installMarkerKey = "so.cap.mobile.installed"

    /// Created on first use: by the UI, or by a background launch that only exists to finish an upload.
    static let shared: AppServices = {
        let store = KeychainCredentialStore()
        let defaults = UserDefaults.standard
        let firstLaunch = !defaults.bool(forKey: installMarkerKey)
        if firstLaunch {
            store.delete()
            defaults.set(true, forKey: installMarkerKey)
        }
        return AppServices(environment: resolveEnvironment(), store: store, firstLaunch: firstLaunch)
    }()

    static var uploadsDirectory: URL {
        URL.applicationSupportDirectory.appending(path: "CapUploads", directoryHint: .isDirectory)
    }

    static var recordingsDirectory: URL {
        URL.applicationSupportDirectory.appending(path: "CapRecordings", directoryHint: .isDirectory)
    }

    static var analyticsQueue: URL {
        URL.applicationSupportDirectory.appending(path: "CapAnalytics", directoryHint: .isDirectory).appending(path: "queue.json")
    }

    /// Debug builds talk to cap.so unless pointed elsewhere, and a developer's taps are not usage.
    static func recordsUsage(_ environment: CapEnvironment) -> Bool {
        #if DEBUG
        environment.baseURL.host().map(CapEnvironment.isLocalDevelopmentHost) ?? false
        #else
        true
        #endif
    }

    init(environment: CapEnvironment, store: any CredentialPersisting, firstLaunch: Bool = false) {
        let vault = CredentialVault(store: store)
        let (stream, continuation) = AsyncStream.makeStream(of: CredentialSnapshot.self, bufferingPolicy: .bufferingNewest(4))
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        let api = CapAPI(
            environment: environment,
            userAgent: "Cap-iOS/\(version) (\(build))",
            credentials: { vault.credentials },
            onUnauthorized: { continuation.yield($0) }
        )
        self.environment = environment
        self.vault = vault
        self.api = api
        self.unauthorized = stream
        images = ImagePipeline(environment: environment, headers: { api.mediaHeaders(for: $0) })
        cache = DiskCache()
        uploads = UploadEngine(environment: environment)
        backgroundUploads = BackgroundUploads(directory: Self.uploadsDirectory)
        recordings = RecordingUploads(
            root: Self.recordingsDirectory,
            api: api,
            engine: uploads,
            currentUserId: { vault.credentials?.userId },
            keepAlive: BackgroundTime.begin
        )
        let engine = uploads
        screenRecordings = ScreenRecordingStore.root.map { root in
            RecordingUploads(
                root: root,
                api: api,
                engine: engine,
                currentUserId: { vault.credentials?.userId },
                keepAlive: BackgroundTime.begin,
                configuration: RecordingUploads.makeConfiguration(identifier: RecordingUploads.screenSessionIdentifier, sharedContainer: ScreenRecordingStore.groupIdentifier),
                adoptsHandOffs: true
            )
        }
        analytics = Analytics(
            api: api,
            app: .current(),
            storage: Self.analyticsQueue,
            isEnabled: Self.recordsUsage(environment),
            currentUserId: { vault.credentials?.userId }
        )
        self.firstLaunch = firstLaunch
    }

    static func resolveEnvironment() -> CapEnvironment {
        #if DEBUG
        if let override = ProcessInfo.processInfo.environment["CAP_API_BASE_URL"],
           let environment = CapEnvironment(string: override, allowInsecureLocalhost: true) {
            return environment
        }
        let allowLocal = true
        #else
        let allowLocal = false
        #endif
        if let configured = Bundle.main.object(forInfoDictionaryKey: "CapAPIBaseURL") as? String,
           let environment = CapEnvironment(string: configured, allowInsecureLocalhost: allowLocal) {
            return environment
        }
        return .production
    }
}

nonisolated enum BackgroundTime {
    private final class Token: @unchecked Sendable {
        // Only touched on the main queue.
        var identifier: UIBackgroundTaskIdentifier = .invalid
    }

    static func begin() -> @Sendable () -> Void {
        let token = Token()
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                token.identifier = UIApplication.shared.beginBackgroundTask(withName: "Cap recording") {
                    UIApplication.shared.endBackgroundTask(token.identifier)
                    token.identifier = .invalid
                }
            }
        }
        return {
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard token.identifier != .invalid else { return }
                    UIApplication.shared.endBackgroundTask(token.identifier)
                    token.identifier = .invalid
                }
            }
        }
    }
}

@MainActor
@Observable
final class AppModel {
    enum Phase {
        case signedOut
        case signedIn(SessionModel)
    }

    private static let log = Logger(subsystem: "so.cap.mobile", category: "session")

    let services: AppServices
    private(set) var phase: Phase
    var signedOutNotice: String?
    var pendingShareLink: ShareTarget?

    init() {
        services = AppServices.shared
        let firstLaunch = services.firstLaunch
        #if DEBUG
        Self.seedDebugSession(services)
        #endif
        if let credentials = services.vault.credentials {
            phase = .signedIn(SessionModel(services: services, credentials: credentials))
        } else {
            phase = .signedOut
        }
        let services = services
        Task.detached(priority: .utility) {
            if firstLaunch {
                await services.cache.removeAll()
                await services.images.removeAll()
            } else {
                await services.images.prune()
            }
            let temporary = FileManager.default.temporaryDirectory
            for name in ["uploads", "picked"] {
                try? FileManager.default.removeItem(at: temporary.appending(path: name, directoryHint: .isDirectory))
            }
            services.backgroundUploads.removeOrphanedFiles()
        }
        observeUnauthorized()
        observeUnlock()
    }

    /// A background launch on a locked phone can't read the session yet; pick it up once the phone unlocks.
    private func observeUnlock() {
        NotificationCenter.default.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, case .signedOut = self.phase, let credentials = self.services.vault.credentials else { return }
                self.phase = .signedIn(SessionModel(services: self.services, credentials: credentials))
            }
        }
    }

    #if DEBUG
    private static func seedDebugSession(_ services: AppServices) {
        let environment = ProcessInfo.processInfo.environment
        if environment["CAP_DEBUG_SIGNED_OUT"] == "1" {
            services.vault.clear()
            return
        }
        guard let raw = environment["CAP_DEBUG_SESSION"],
              let host = services.environment.baseURL.host(),
              CapEnvironment.isLocalDevelopmentHost(host)
        else { return }
        let parts = raw.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2, APIKeyValidator.isPlausible(parts[0]), CapID(parts[1]) != nil else { return }
        try? services.vault.replace(with: CredentialSnapshot(apiKey: parts[0], userId: parts[1]))
    }
    #endif

    var session: SessionModel? {
        if case let .signedIn(session) = phase { return session }
        return nil
    }

    private func observeUnauthorized() {
        let stream = services.unauthorized
        Task { [weak self] in
            for await snapshot in stream {
                await self?.handleUnauthorized(snapshot)
            }
        }
    }

    private func handleUnauthorized(_ snapshot: CredentialSnapshot) async {
        guard services.vault.clear(ifMatching: snapshot) else { return }
        Self.log.notice("Session rejected by server, signing out")
        await finishSignOut(notice: "Your session expired. Sign in again.")
    }

    func completeSignIn(_ session: APIKeySession) throws {
        let credentials = CredentialSnapshot(apiKey: session.apiKey, userId: session.userId)
        try services.vault.replace(with: credentials)
        signedOutNotice = nil
        phase = .signedIn(SessionModel(services: services, credentials: credentials))
        Task { await PushNotifications.shared.registerIfAllowed() }
    }

    func signOut() async {
        Usage.track("user_signed_out")
        // Goes out under the session that is about to end. Nothing here waits for it.
        let analytics = services.analytics
        Task { await analytics.flush() }
        let api = services.api
        let revoke = Task {
            await PushNotifications.shared.unregister()
            try? await api.revokeSession()
        }
        let timeout = Task {
            try? await Task.sleep(for: .seconds(4))
            revoke.cancel()
        }
        await revoke.value
        timeout.cancel()
        services.vault.clear()
        await finishSignOut(notice: nil)
    }

    private func finishSignOut(notice: String?) async {
        session?.tearDown()
        phase = .signedOut
        signedOutNotice = notice
        pendingShareLink = nil
        services.analytics.signedOut()
        services.api.clearVideoAccess()
        await services.backgroundUploads.cancelAll()
        await services.recordings.discardAll()
        await services.screenRecordings?.discardAll()
        await UploadActivities.shared.endAll()
        await services.cache.removeAll()
        await services.images.removeAll()
        URLCache.shared.removeAllCachedResponses()
        HTTPCookieStorage.shared.removeCookies(since: .distantPast)
        let temporary = FileManager.default.temporaryDirectory
        if let items = try? FileManager.default.contentsOfDirectory(at: temporary, includingPropertiesForKeys: nil) {
            for item in items { try? FileManager.default.removeItem(at: item) }
        }
    }

    func open(_ url: URL) {
        guard let link = DeepLink.parse(url) else { return }
        switch link {
        case let .share(target):
            pendingShareLink = target
        case .authCallback:
            break
        case .stopScreenRecording:
            ProcessStats.note("Stop tapped in the Live Activity, app state \(UIApplication.shared.applicationState.rawValue)")
            ScreenRecordingSession.shared.stop()
            RecordingCoordinator.shared.showHome()
        }
    }
}
