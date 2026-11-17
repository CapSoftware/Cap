import CapKit
import Foundation
import Observation

@MainActor
@Observable
final class LibraryModel {
    enum Status: Equatable {
        case idle
        case loading
        case loaded
        case failed(CapAPIError)
    }

    let key: LibraryKey
    private(set) var caps: [CapSummary] = []
    private(set) var folders: [Folder] = []
    private(set) var status: Status = .idle
    private(set) var isLoadingMore = false
    private(set) var hasMore = false
    private(set) var total = 0
    private(set) var loadMoreError: CapAPIError?
    private(set) var showingCachedData = false

    @ObservationIgnored private weak var session: SessionModel?
    @ObservationIgnored private var page = 1
    @ObservationIgnored private var stale = true
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var lastRefresh: Date?

    static let pageSize = 30

    init(key: LibraryKey, session: SessionModel) {
        self.key = key
        self.session = session
    }

    var isEmpty: Bool { caps.isEmpty && folders.isEmpty }

    func loadIfNeeded() async {
        if status == .idle, caps.isEmpty, let session {
            let cached = await session.services.cache.read(CapsPage.self, namespace: session.credentials.userId, key: key.cacheKey)
            if let cached, caps.isEmpty {
                apply(firstPage: cached)
                showingCachedData = true
                status = .loaded
            }
        }
        let recentlyRefreshed = lastRefresh.map { Date.now.timeIntervalSince($0) < 20 } ?? false
        if stale || !recentlyRefreshed || status == .idle {
            await refresh()
        }
    }

    func refresh() async {
        guard let session else { return }
        generation += 1
        let current = generation
        if caps.isEmpty && folders.isEmpty { status = .loading }
        do {
            let page = try await session.api.listCaps(folderId: key.folderId, spaceId: key.scope.spaceId, page: 1, limit: Self.pageSize)
            guard current == generation else { return }
            apply(firstPage: page)
            status = .loaded
            showingCachedData = false
            stale = false
            lastRefresh = .now
            loadMoreError = nil
            let cache = session.services.cache
            let namespace = session.credentials.userId
            let cacheKey = key.cacheKey
            Task.detached(priority: .utility) {
                await cache.write(page, namespace: namespace, key: cacheKey)
            }
            schedulePolling()
        } catch {
            guard current == generation, error != .cancelled else { return }
            if caps.isEmpty && folders.isEmpty {
                status = .failed(error)
            } else {
                session.toasts.show(error)
            }
        }
    }

    func loadMoreIfNeeded(after cap: CapSummary) async {
        guard hasMore, !isLoadingMore, loadMoreError == nil, let index = caps.firstIndex(where: { $0.id == cap.id }), index >= caps.count - 6 else { return }
        await loadMore()
    }

    func loadMore() async {
        guard let session, hasMore, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        let current = generation
        do {
            let next = try await session.api.listCaps(folderId: key.folderId, spaceId: key.scope.spaceId, page: page + 1, limit: Self.pageSize)
            guard current == generation else { return }
            let known = Set(caps.map(\.id))
            caps.append(contentsOf: next.caps.filter { !known.contains($0.id) })
            page = next.page
            hasMore = next.hasMore && !next.caps.isEmpty
            total = next.total
            loadMoreError = nil
            schedulePolling()
        } catch {
            guard error != .cancelled else { return }
            loadMoreError = error
        }
    }

    func retryLoadMore() async {
        loadMoreError = nil
        await loadMore()
    }

    private func apply(firstPage: CapsPage) {
        caps = firstPage.caps
        if key.folderId == nil { folders = firstPage.folders }
        page = firstPage.page
        hasMore = firstPage.hasMore
        total = firstPage.total
    }

    func replace(_ summary: CapSummary) {
        guard let index = caps.firstIndex(where: { $0.id == summary.id }) else { return }
        caps[index] = summary
    }

    func remove(_ id: String) {
        guard caps.contains(where: { $0.id == id }) else { return }
        caps.removeAll { $0.id == id }
        total = max(0, total - 1)
    }

    func insert(_ folder: Folder) {
        guard !folders.contains(where: { $0.id == folder.id }) else { return }
        folders.insert(folder, at: 0)
    }

    func markStale() {
        stale = true
    }

    func cancel() {
        generation += 1
        pollTask?.cancel()
        pollTask = nil
    }

    private func schedulePolling() {
        pollTask?.cancel()
        let processing = caps.filter { $0.isProcessing && $0.isOwned(by: session?.credentials.userId) }.map(\.id)
        guard !processing.isEmpty else { return }
        pollTask = Task { [weak self] in
            var delay = Duration.seconds(3)
            while !Task.isCancelled {
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled, let self else { return }
                let done = await self.pollOnce()
                if done { return }
                delay = min(delay * 1.5, .seconds(15))
            }
        }
    }

    private func pollOnce() async -> Bool {
        guard let session else { return true }
        let ids = caps.filter { $0.isProcessing && $0.isOwned(by: session.credentials.userId) }.map(\.id)
        guard !ids.isEmpty else { return true }
        do {
            let statuses = try await session.api.capStatuses(ids: ids)
            var finished = false
            for status in statuses {
                guard let index = caps.firstIndex(where: { $0.id == status.id }) else { continue }
                if status.upload == nil || status.upload?.phase == .complete {
                    finished = true
                }
                caps[index].upload = status.upload
            }
            if finished {
                await refresh()
                return true
            }
            return false
        } catch {
            return error == .unauthorized
        }
    }
}
