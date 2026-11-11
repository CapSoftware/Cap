import CapKit
import OSLog
import SwiftUI
import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private static var orientations: UIInterfaceOrientationMask = .portrait

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Runs for background launches too, when iOS only woke Cap to finish an upload.
        BackgroundUploadCoordinator.shared.start()
        RecordingCoordinator.shared.start()
        UNUserNotificationCenter.current().delegate = self
        Task { await PushNotifications.shared.registerIfAllowed() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushNotifications.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        Logger(subsystem: "so.cap.mobile", category: "push").error("Push registration failed: \(error.localizedDescription, privacy: .public)")
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        if await PushNotifications.shared.open(response.notification.request.content.userInfo) { return }
        await RecordingCoordinator.shared.collectFinishedScreenRecording(showHome: false)
        await RecordingCoordinator.shared.showHome()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        if notification.request.content.userInfo["capId"] != nil { return [.banner, .list, .sound] }
        await RecordingCoordinator.shared.collectFinishedScreenRecording(showHome: true)
        return []
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        nonisolated(unsafe) let handler = completionHandler
        switch identifier {
        case BackgroundUploads.sessionIdentifier:
            BackgroundUploadCoordinator.shared.start()
            AppServices.shared.backgroundUploads.setFinishEventsHandler { handler() }
        case RecordingUploads.sessionIdentifier:
            RecordingCoordinator.shared.start()
            AppServices.shared.recordings.setFinishEventsHandler { handler() }
        case RecordingUploads.screenSessionIdentifier:
            RecordingCoordinator.shared.start()
            AppServices.shared.screenRecordings?.setFinishEventsHandler { handler() }
        default:
            completionHandler()
        }
    }

    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        if let window, Self.isLargeScreen(window.traitCollection) { return .allButUpsideDown }
        return Self.orientations
    }

    /// The open iPhone Duo is regular both ways in any orientation, so Cap turns with it like an iPad app.
    /// A phone is compact in at least one direction and stays portrait outside fullscreen video.
    static func isLargeScreen(_ traits: UITraitCollection) -> Bool {
        traits.horizontalSizeClass == .regular && traits.verticalSizeClass == .regular
    }

    static func allowLandscape(_ allowed: Bool, in scene: UIWindowScene?) {
        orientations = allowed ? .allButUpsideDown : .portrait
        guard let scene else { return }
        for window in scene.windows {
            window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        }
        if !allowed, !isLargeScreen(scene.traitCollection) {
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait))
        }
    }
}

@main
struct CapApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(\.imagePipeline, model.services.images)
                .environment(\.capEnvironment, model.services.environment)
                .onOpenURL { model.open($0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { model.open(url) }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch model.phase {
            case .signedOut:
                SignInView()
                    .transition(.opacity)
            case let .signedIn(session):
                MainTabView(session: session)
                    .id(session.credentials.apiKey)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: model.session?.credentials.apiKey)
    }
}

enum AppTab: Hashable {
    case caps
    case record
    case analytics
    case settings
}

struct RecorderRequest: Identifiable {
    let id = UUID()
    let folderId: String?
}

extension Notification.Name {
    /// The object is the folder id to save into, if any.
    static let capOpenRecorder = Notification.Name("so.cap.mobile.openRecorder")
    /// The object is the Cap's id.
    static let capOpenCap = Notification.Name("so.cap.mobile.openCap")
    static let capShowHome = Notification.Name("so.cap.mobile.showHome")
}

enum Route: Hashable {
    case cap(CapID)
    case share(ShareTarget)
    case folder(Folder, LibraryScope)
    case capAnalytics(CapID, title: String)
    case profile
    case organization
    case notifications
    case deleteAccount
}

struct MainTabView: View {
    let session: SessionModel
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var tab: AppTab = .caps
    @State private var homePath: [Route] = []
    @State private var analyticsPath: [Route] = []
    @State private var settingsPath: [Route] = []
    @State private var recorder: RecorderRequest?
    @State private var capModels = CapDetailModels()
    @State private var heldLayout: CapsLayout?

    /// Held while a Cap's editor or fullscreen player is up: swapping layouts under it would rebuild the screen that
    /// presents it and close it, losing unsaved edits. It changes once the cover closes.
    private var capsLayout: CapsLayout {
        heldLayout ?? CapsLayout(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
    }

    private var openRoutes: [Route] {
        homePath + analyticsPath + settingsPath
    }

    var body: some View {
        tabs
        .tabBarMinimizeBehavior(.onScrollDown)
        .onChange(of: tab) { previous, selected in
            // The Record tab opens the recorder over whatever was showing; it is never a page itself.
            guard selected == .record else { return }
            recorder = RecorderRequest(folderId: nil)
            Task { tab = previous == .record ? .caps : previous }
        }
        .fullScreenCover(item: $recorder) { request in
            RecordView(session: session, folderId: request.folderId)
        }
        .onReceive(NotificationCenter.default.publisher(for: .capOpenRecorder)) { note in
            guard recorder == nil else { return }
            recorder = RecorderRequest(folderId: note.object as? String)
        }
        .onReceive(NotificationCenter.default.publisher(for: .capOpenCap)) { note in
            guard let id = (note.object as? String).flatMap(CapID.init) else { return }
            recorder = nil
            tab = .caps
            homePath = [.cap(id)]
        }
        .onReceive(NotificationCenter.default.publisher(for: .capShowHome)) { _ in
            // A camera recording keeps its screen.
            guard RecordingCoordinator.shared.activeModel?.isRecording != true else { return }
            recorder = nil
            tab = .caps
            homePath = []
        }
        .onAppear {
            RecordingCoordinator.shared.session = session
            let coordinator = RecordingCoordinator.shared
            coordinator.collectFinishedScreenRecording(showHome: false)
            // A fresh launch after a recording stopped while Cap was away.
            if coordinator.showsHomeOnReturn { coordinator.showHome() }
        }
        .environment(session)
        .toasts(session.toasts)
        .task { await session.start() }
        #if DEBUG
        .task { applyDebugRoute() }
        #endif
        .onChange(of: model.pendingShareLink, initial: true) { _, link in
            guard let link else { return }
            model.pendingShareLink = nil
            tab = .caps
            homePath = [.share(link)]
        }
        .onChange(of: PushNotifications.shared.pendingCapId, initial: true) { _, id in
            guard let id else { return }
            PushNotifications.shared.pendingCapId = nil
            recorder = nil
            tab = .caps
            homePath = [.cap(id)]
        }
    }

    #if DEBUG
    private func applyDebugRoute() {
        guard let raw = ProcessInfo.processInfo.environment["CAP_DEBUG_ROUTE"] else { return }
        let parts = raw.split(separator: ":", maxSplits: 1).map(String.init)
        switch (parts.first, parts.count > 1 ? parts[1] : nil) {
        case ("cap", let rest?):
            if let url = URL(string: "cap://s/\(rest)"), case let .share(target)? = DeepLink.parse(url) {
                model.pendingShareLink = target
            }
        case ("edit", let id?):
            if let url = URL(string: "cap://s/\(id)"), case let .share(target)? = DeepLink.parse(url) {
                EditorDebug.openOnLoad = true
                model.pendingShareLink = target
            }
        case ("tab", "analytics"?):
            tab = .analytics
        case ("tab", "settings"?):
            tab = .settings
        case ("settings", "organization"?):
            tab = .settings
            settingsPath = [.organization]
        case ("settings", "profile"?):
            tab = .settings
            settingsPath = [.profile]
        case ("analytics", let id?):
            if let capId = CapID(id) { homePath = [.capAnalytics(capId, title: "Walkthrough: the new Cap 0.6.2 editor")] }
        default:
            break
        }
    }
    #endif

    private var tabs: some View {
        TabView(selection: $tab) {
            Tab("Caps", systemImage: "play.rectangle.on.rectangle.fill", value: AppTab.caps) {
                switch capsLayout {
                case .stack:
                    NavigationStack(path: $homePath) {
                        HomeView()
                            .navigationDestination(for: Route.self, destination: destination)
                    }
                case .split:
                    LibrarySplitView(path: $homePath, destination: destination)
                }
            }
            Tab("Record", systemImage: "record.circle", value: AppTab.record) {
                Color.clear
            }
            Tab("Analytics", systemImage: "chart.xyaxis.line", value: AppTab.analytics) {
                NavigationStack(path: $analyticsPath) {
                    AnalyticsScreen(scope: .organization)
                        .navigationDestination(for: Route.self, destination: destination)
                }
            }
            Tab("Settings", systemImage: "gearshape.fill", value: AppTab.settings) {
                NavigationStack(path: $settingsPath) {
                    SettingsView()
                        .navigationDestination(for: Route.self, destination: destination)
                }
            }
        }
        .environment(capModels)
        .environment(\.capsLayout, capsLayout)
        .onChange(of: openRoutes) { _, routes in capModels.keep(routes) }
        .onChange(of: capModels.isCovered) { _, covered in heldLayout = covered ? capsLayout : nil }
    }

    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case let .cap(id):
            CapDetailView(model: capModels.model(for: route, target: ShareTarget(id: id)))
        case let .share(target):
            CapDetailView(model: capModels.model(for: route, target: target))
        case let .folder(folder, scope):
            FolderView(folder: folder, scope: scope)
        case let .capAnalytics(id, title):
            AnalyticsScreen(scope: .cap(id, title: title))
        case .profile:
            ProfileSettingsView()
        case .organization:
            OrganizationSettingsView()
        case .notifications:
            NotificationSettingsView()
        case .deleteAccount:
            DeleteAccountView()
        }
    }
}
