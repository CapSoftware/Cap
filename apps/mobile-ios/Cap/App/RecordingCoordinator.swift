import CapKit
import Foundation
import Observation
import os
import UIKit

@MainActor
final class RecordingCoordinator {
    static let shared = RecordingCoordinator()

    private static let log = Logger(subsystem: "so.cap.mobile", category: "recordings")
    private var started = false
    weak var session: SessionModel?
    weak var activeModel: RecordModel?

    func start() {
        guard !started else { return }
        started = true
        ScreenRecordingSession.shared.start()
        let services = AppServices.shared
        let sources = [(services.recordings, RecentRecordings.Kind.camera)] + (services.screenRecordings.map { [($0, .screen)] } ?? [])
        for (recordings, kind) in sources {
            Task {
                for await event in recordings.events {
                    self.handle(event, from: recordings, kind: kind)
                }
            }
        }
        Task {
            await services.recordings.resumeAll()
            await services.screenRecordings?.adopt()
            await services.screenRecordings?.resumeAll()
        }
        let center = NotificationCenter.default
        for name in [UIApplication.protectedDataDidBecomeAvailableNotification, UIApplication.didBecomeActiveNotification] {
            center.addObserver(forName: name, object: nil, queue: .main) { _ in
                Task {
                    await AppServices.shared.recordings.resumeAll()
                    await AppServices.shared.screenRecordings?.adopt()
                    await AppServices.shared.screenRecordings?.resumeAll()
                }
            }
        }
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                let coordinator = RecordingCoordinator.shared
                if coordinator.showsHomeOnReturn { coordinator.showHome() }
                coordinator.collectFinishedScreenRecording(showHome: true)
            }
        }
    }

    /// Survives Cap being closed while away, so even a fresh launch opens on the homepage.
    private static let showHomeKey = "showHomeOnReturn"

    var showsHomeOnReturn: Bool { UserDefaults.standard.bool(forKey: Self.showHomeKey) }

    /// Cap can't come forward by itself, so while it's away this waits for it to be back in front.
    func showHome() {
        guard UIApplication.shared.applicationState == .active else {
            UserDefaults.standard.set(true, forKey: Self.showHomeKey)
            return
        }
        UserDefaults.standard.removeObject(forKey: Self.showHomeKey)
        ProcessStats.note("Showing the homepage")
        NotificationCenter.default.post(name: .capShowHome, object: nil)
    }

    func collectFinishedScreenRecording(showHome: Bool) {
        guard let session, let entry = RecordingHandoff.take(), CapID(entry.capId) != nil else { return }
        refreshLibrary(session)
        RecentRecordings.shared.finishedElsewhere(capId: entry.capId, shareUrl: entry.shareUrl)
        if showHome { self.showHome() }
    }

    func cameraRecordingStopped() {
        if let session { refreshLibrary(session) }
    }

    private func refreshLibrary(_ session: SessionModel) {
        session.invalidateLibraries()
        if let key = session.currentLibraryKey {
            Task { await session.library(for: key).refresh() }
        }
    }

    private func handle(_ event: RecordingUploadEvent, from recordings: RecordingUploads, kind: RecentRecordings.Kind) {
        let recent = RecentRecordings.shared
        switch event {
        case let .created(jobId, capId, shareUrl):
            UploadActivities.shared.link(id: jobId, capId: capId)
            recent.created(jobId: jobId, capId: capId, shareUrl: shareUrl, kind: kind)
            // The new Cap shows in the library while it uploads; a camera recording's once it stops.
            if recordings.job(jobId)?.phase != .recording, let session { refreshLibrary(session) }
        case let .progress(jobId, uploaded, total):
            guard total > 0 else { return }
            let fraction = Double(uploaded) / Double(total)
            // Only after stopping: while capturing, segments land faster than the total grows.
            guard recordings.job(jobId)?.phase != .recording else { return }
            recent.progress(jobId: jobId, fraction: fraction)
            UploadActivities.shared.update(id: jobId, phase: .uploading, fraction: fraction)
        case let .completed(job):
            recent.completed(jobId: job.id)
            let inApp = UIApplication.shared.applicationState == .active
            Task { await UploadActivities.shared.finish(id: job.id, phase: .done, dismissImmediately: inApp) }
            if let session { refreshLibrary(session) }
            PushNotifications.shared.askAfterFirstUpload()
        case let .failed(job, message):
            Self.log.error("Recording upload failed for \(job.id, privacy: .public)")
            recent.failed(jobId: job.id, message: message)
            activeModel?.uploadFailed(jobId: job.id)
            if !recent.isRecorderVisible {
                session?.toasts.show(message, systemImage: "exclamationmark.triangle.fill", style: .error)
            }
            Task {
                await UploadActivities.shared.finish(id: job.id, phase: .failed, message: message)
                // Segments without a completed Cap can't be played; don't leave an empty Cap behind.
                await recordings.dismissFailed(job.id)
                if let capId = job.capId.flatMap(CapID.init) {
                    try? await AppServices.shared.api.deleteCap(capId)
                    session?.capDeleted(capId.rawValue)
                }
            }
        }
    }
}

@MainActor
@Observable
final class RecentRecordings {
    static let shared = RecentRecordings()

    enum Kind: Equatable {
        case camera, screen
    }

    struct Item: Identifiable, Equatable {
        enum Status: Equatable {
            case saving
            case uploading(Double)
            case ready
            case failed(String)
        }

        let id = UUID()
        let stoppedAt = Date.now
        let kind: Kind
        var jobId: String?
        var capId: String?
        var shareUrl: String?
        var status: Status
        var linkCopied = false
    }

    private(set) var items: [Item] = []
    @ObservationIgnored var isRecorderVisible = false
    @ObservationIgnored private var links: [String: (capId: String, shareUrl: String)] = [:]
    @ObservationIgnored private var placeholderTimeout: Task<Void, Never>?

    func stopped(jobId: String, kind: Kind) {
        var item = Item(kind: kind, jobId: jobId, status: .uploading(0))
        if let link = links.removeValue(forKey: jobId) {
            item.capId = link.capId
            item.shareUrl = link.shareUrl
        }
        insert(item)
        copyLinkIfNewest(item.id)
    }

    func savingScreen() {
        // Once per stop, however it was stopped and whichever signal arrives first.
        guard !items.contains(where: { $0.kind == .screen && ($0.status == .saving || Date.now.timeIntervalSince($0.stoppedAt) < 10) }) else { return }
        insert(Item(kind: .screen, status: .saving))
        placeholderTimeout?.cancel()
        placeholderTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled else { return }
            // Nothing came back: the extension finishes it, and says so in a notification.
            self?.items.removeAll { $0.status == .saving }
        }
    }

    func created(jobId: String, capId: String, shareUrl: String, kind: Kind) {
        if let index = items.firstIndex(where: { $0.jobId == jobId }) {
            items[index].capId = capId
            items[index].shareUrl = shareUrl
            copyLinkIfNewest(items[index].id)
            return
        }
        guard kind == .screen else {
            links[jobId] = (capId, shareUrl)
            return
        }
        // Screen recordings only reach Cap once they've stopped.
        let index = items.firstIndex { $0.kind == .screen && ($0.capId == capId || $0.status == .saving) }
        if let index {
            items[index].jobId = jobId
            items[index].capId = capId
            items[index].shareUrl = shareUrl
            items[index].status = .uploading(0)
            copyLinkIfNewest(items[index].id)
        } else {
            let item = Item(kind: .screen, jobId: jobId, capId: capId, shareUrl: shareUrl, status: .uploading(0))
            insert(item)
            copyLinkIfNewest(item.id)
        }
        if !items.contains(where: { $0.status == .saving }) { placeholderTimeout?.cancel() }
    }

    func progress(jobId: String, fraction: Double) {
        guard let index = items.firstIndex(where: { $0.jobId == jobId }), case .uploading = items[index].status else { return }
        items[index].status = .uploading(fraction)
    }

    func completed(jobId: String) {
        guard let index = items.firstIndex(where: { $0.jobId == jobId }) else { return }
        items[index].status = .ready
    }

    func failed(jobId: String, message: String) {
        links[jobId] = nil
        guard let index = items.firstIndex(where: { $0.jobId == jobId }) else { return }
        items[index].status = .failed(message)
    }

    func finishedElsewhere(capId: String, shareUrl: String) {
        guard !items.contains(where: { $0.capId == capId }) else { return }
        for index in items.indices { items[index].linkCopied = false }
        let item = Item(kind: .screen, capId: capId, shareUrl: shareUrl, status: .ready, linkCopied: true)
        if let index = items.firstIndex(where: { $0.kind == .screen && $0.status == .saving }) {
            items[index] = item
        } else {
            insert(item)
        }
        if !isRecorderVisible { RecordingCoordinator.shared.session?.toasts.show("Screen recording ready. Link copied", systemImage: "link") }
    }

    func copyLink(_ item: Item) {
        guard let shareUrl = item.shareUrl, let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        UIPasteboard.general.string = shareUrl
        for other in items.indices { items[other].linkCopied = false }
        items[index].linkCopied = true
    }

    func dismiss(_ item: Item) {
        items.removeAll { $0.id == item.id }
    }

    private func insert(_ item: Item) {
        items.insert(item, at: 0)
        if items.count > 6 { items.removeLast(items.count - 6) }
    }

    private func copyLinkIfNewest(_ id: UUID) {
        guard items.first?.id == id, let item = items.first, !item.linkCopied, item.shareUrl != nil else { return }
        copyLink(item)
        if !isRecorderVisible { RecordingCoordinator.shared.session?.toasts.show("Link copied", systemImage: "link") }
    }
}
