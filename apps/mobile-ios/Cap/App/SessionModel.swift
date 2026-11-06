import CapKit
import Foundation
import Observation

enum LibraryScope: Hashable, Sendable {
    case personal
    case space(id: String)

    var spaceId: String? {
        switch self {
        case .personal: nil
        case let .space(id): id
        }
    }
}

struct LibraryKey: Hashable, Sendable {
    let organizationId: String
    let scope: LibraryScope
    let folderId: String?

    var cacheKey: String {
        ["caps", organizationId, scope.spaceId ?? "personal", folderId ?? "root"].joined(separator: "-")
    }
}

@MainActor
@Observable
final class SessionModel {
    let services: AppServices
    let credentials: CredentialSnapshot

    private(set) var bootstrap: Bootstrap?
    private(set) var bootstrapError: CapAPIError?
    private(set) var isRefreshingBootstrap = false
    private(set) var isSwitchingOrganization = false
    private(set) var plan: PlanStatus?
    private(set) var planError: CapAPIError?
    var scope: LibraryScope = .personal
    let uploads: UploadCenter
    let toasts = ToastCenter()

    @ObservationIgnored private var libraries: [LibraryKey: LibraryModel] = [:]
    @ObservationIgnored private var started = false
    @ObservationIgnored private var tornDown = false

    init(services: AppServices, credentials: CredentialSnapshot) {
        self.services = services
        self.credentials = credentials
        uploads = UploadCenter(services: services, userId: credentials.userId)
        uploads.session = self
    }

    var api: CapAPI { services.api }
    var user: CapUser? { bootstrap?.user }
    var organizationId: String? { bootstrap?.activeOrganizationId ?? bootstrap?.user.activeOrganizationId }
    var activeOrganization: Organization? { bootstrap?.activeOrganization }
    var spaces: [Space] { bootstrap?.spaces ?? [] }
    var isPro: Bool { plan?.upgraded ?? false }

    var scopeTitle: String {
        switch scope {
        case .personal: "My Caps"
        case let .space(id): spaces.first { $0.id == id }?.name ?? "Space"
        }
    }

    /// The scope bar only earns its space when there's somewhere else to go than My Caps.
    var showsScopeBar: Bool { !spaces.isEmpty || (bootstrap?.organizations.count ?? 0) > 1 }

    var selectedSpace: Space? {
        guard case let .space(id) = scope else { return nil }
        return spaces.first { $0.id == id }
    }

    func start() async {
        guard !started else { return }
        started = true
        if let cached = await services.cache.read(Bootstrap.self, namespace: credentials.userId, key: "bootstrap"), bootstrap == nil {
            bootstrap = cached
            restoreScope()
        }
        async let bootstrapRefresh: Void = refreshBootstrap()
        async let planRefresh: Void = refreshPlan()
        _ = await (bootstrapRefresh, planRefresh)
    }

    func refreshBootstrap() async {
        guard !isRefreshingBootstrap else { return }
        isRefreshingBootstrap = true
        defer { isRefreshingBootstrap = false }
        do {
            let fresh = try await api.bootstrap()
            guard !tornDown else { return }
            apply(fresh)
            bootstrapError = nil
        } catch {
            guard !tornDown, error != .cancelled else { return }
            bootstrapError = error
        }
    }

    func refreshPlan() async {
        do {
            plan = try await api.plan()
            planError = nil
        } catch {
            guard error != .cancelled else { return }
            planError = error
        }
    }

    private func apply(_ fresh: Bootstrap) {
        let organizationChanged = organizationId != (fresh.activeOrganizationId ?? fresh.user.activeOrganizationId)
        bootstrap = fresh
        if organizationChanged {
            libraries.removeAll()
        }
        restoreScope()
        let cache = services.cache
        let namespace = credentials.userId
        Task.detached(priority: .utility) {
            await cache.write(fresh, namespace: namespace, key: "bootstrap")
        }
    }

    private var scopeDefaultsKey: String? {
        organizationId.map { "so.cap.mobile.scope.\(credentials.userId).\($0)" }
    }

    private func restoreScope() {
        guard let key = scopeDefaultsKey else { return }
        if let stored = UserDefaults.standard.string(forKey: key), spaces.contains(where: { $0.id == stored }) {
            scope = .space(id: stored)
        } else if case let .space(id) = scope, !spaces.contains(where: { $0.id == id }) {
            scope = .personal
        }
    }

    func select(_ scope: LibraryScope) {
        self.scope = scope
        guard let key = scopeDefaultsKey else { return }
        if let spaceId = scope.spaceId {
            UserDefaults.standard.set(spaceId, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    func switchOrganization(to organization: Organization) async {
        guard organization.id != organizationId, !isSwitchingOrganization else { return }
        isSwitchingOrganization = true
        defer { isSwitchingOrganization = false }
        do {
            let fresh = try await api.setActiveOrganization(organization.id)
            libraries.removeAll()
            scope = .personal
            apply(fresh)
            toasts.show("Switched to \(organization.name)", systemImage: "building.2")
        } catch {
            toasts.show(error)
        }
    }

    func updateUser(_ user: CapUser) {
        guard var current = bootstrap else { return }
        current.user = user
        apply(current)
    }

    func library(for key: LibraryKey) -> LibraryModel {
        if let existing = libraries[key] { return existing }
        let model = LibraryModel(key: key, session: self)
        libraries[key] = model
        return model
    }

    var currentLibraryKey: LibraryKey? {
        guard let organizationId else { return nil }
        return LibraryKey(organizationId: organizationId, scope: scope, folderId: nil)
    }

    func capChanged(_ summary: CapSummary) {
        for library in libraries.values { library.replace(summary) }
    }

    func capDeleted(_ id: String) {
        for library in libraries.values { library.remove(id) }
    }

    func folderCreated(_ folder: Folder, in key: LibraryKey) {
        libraries[key]?.insert(folder)
    }

    func invalidateLibraries(scope: LibraryScope? = nil) {
        for (key, library) in libraries where scope == nil || key.scope == scope {
            library.markStale()
        }
    }

    func tearDown() {
        tornDown = true
        uploads.cancelAll()
        for library in libraries.values { library.cancel() }
        libraries.removeAll()
    }
}
