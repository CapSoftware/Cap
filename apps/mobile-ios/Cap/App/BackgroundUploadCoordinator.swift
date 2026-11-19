import ActivityKit
import CapKit
import Foundation
import os
import UIKit

@MainActor
final class BackgroundUploadCoordinator {
    static let shared = BackgroundUploadCoordinator()

    private static let log = Logger(subsystem: "so.cap.mobile", category: "uploads")
    private var started = false
    private var reporters: [String: ProgressReporter] = [:]
    private var completing: Set<String> = []
    private var lastUIFraction: [String: Double] = [:]
    private var backgroundTime: [String: BackgroundAssertion] = [:]

    /// The transfer runs in the system's upload daemon either way. Background time keeps the Live Activity
    /// moving for short uploads instead of freezing the moment Cap is suspended.
    func keepProgressLive(capId: String) {
        guard backgroundTime[capId] == nil else { return }
        let assertion = BackgroundAssertion()
        assertion.begin { [weak self] in self?.backgroundTime[capId] = nil }
        backgroundTime[capId] = assertion
    }

    private func releaseBackgroundTime(_ capId: String) {
        backgroundTime.removeValue(forKey: capId)?.end()
    }
    private var imageUploads: [String: Bool] = [:]

    private func isImageUpload(_ capId: String, services: AppServices) -> Bool {
        if let known = imageUploads[capId] { return known }
        let isImage = services.backgroundUploads.records.first { $0.capId == capId }?.isImage ?? false
        imageUploads[capId] = isImage
        return isImage
    }
    weak var center: UploadCenter?

    func start() {
        guard !started else { return }
        started = true
        let services = AppServices.shared
        UploadActivities.shared.restore()
        Task {
            for await event in services.backgroundUploads.events {
                await self.handle(event, services: services)
            }
        }
        Task { await services.backgroundUploads.reconcile() }
        Task { await retryPending() }
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in await BackgroundUploadCoordinator.shared.retryPending() }
        }
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in await BackgroundUploadCoordinator.shared.retryPending() }
        }
    }

    private func handle(_ event: BackgroundUploadEvent, services: AppServices) async {
        switch event {
        case let .progress(capId, sent, total):
            let fraction = total > 0 ? min(1, Double(sent) / Double(total)) : 0
            // Delegate callbacks arrive per chunk; the banner only needs half-percent steps.
            if fraction >= 1 || fraction - (lastUIFraction[capId] ?? -1) >= 0.005 {
                lastUIFraction[capId] = fraction
                center?.progress(capId: capId, fraction: fraction)
            }
            UploadActivities.shared.update(capId: capId, phase: .uploading, fraction: fraction)
            // Screenshot Caps have no upload-progress row on the server; reporting would create one.
            if isImageUpload(capId, services: services) { return }
            if let id = CapID(capId) {
                let reporter = reporters[capId] ?? ProgressReporter(api: services.api, capId: id)
                reporters[capId] = reporter
                reporter.report(sent: sent, total: total)
            }
        case let .uploaded(record):
            reporters[record.capId] = nil
            defer { releaseBackgroundTime(record.capId) }
            lastUIFraction[record.capId] = nil
            await complete(record, services: services)
        case let .failed(record, error):
            reporters[record.capId] = nil
            releaseBackgroundTime(record.capId)
            Self.log.error("Upload failed for \(record.capId, privacy: .public)")
            Usage.track("upload_failed", ["stage": "transfer"])
            services.backgroundUploads.remove(capId: record.capId)
            let message = error.errorDescription ?? "The upload failed. Try again."
            center?.failed(capId: record.capId, message: message)
            await UploadActivities.shared.finish(capId: record.capId, phase: .failed, message: message)
        }
    }

    func trackImport(capId: String, title: String) {
        UploadActivities.shared.start(id: capId, title: title, kind: .loom, phase: .importing, capId: capId)
        let api = AppServices.shared.api
        Task {
            var delay: Duration = .seconds(5)
            for _ in 0..<120 {
                try? await Task.sleep(for: delay)
                delay = min(delay + .seconds(3), .seconds(20))
                guard let status = try? await api.capStatuses(ids: [capId]).first(where: { $0.id == capId }) else { continue }
                guard let upload = status.upload, upload.phase != .complete else {
                    await UploadActivities.shared.finish(capId: capId, phase: .done)
                    return
                }
                if upload.phase == .error {
                    await UploadActivities.shared.finish(capId: capId, phase: .failed, message: "The Loom import failed.")
                    return
                }
                UploadActivities.shared.update(capId: capId, phase: .importing, fraction: upload.fractionCompleted)
            }
        }
    }

    func retryPending() async {
        let services = AppServices.shared
        for record in services.backgroundUploads.records where record.state == .uploaded {
            await complete(record, services: services)
        }
    }

    private func complete(_ record: PendingUpload, services: AppServices) async {
        guard !completing.contains(record.capId) else { return }
        guard let credentials = services.vault.credentials else { return }
        // Never complete an upload for a different account than the one that started it.
        guard credentials.userId == record.userId, let capId = CapID(record.capId) else {
            services.backgroundUploads.remove(capId: record.capId)
            await UploadActivities.shared.finish(capId: record.capId, phase: .failed, message: "Signed out before the upload finished.")
            return
        }
        completing.insert(record.capId)
        defer { completing.remove(record.capId) }
        center?.finishing(capId: record.capId)
        UploadActivities.shared.update(capId: record.capId, phase: .finishing, fraction: 1)

        let assertion = BackgroundAssertion()
        assertion.begin {}
        defer { assertion.end() }
        do {
            try await services.api.completeUpload(capId, rawFileKey: record.rawFileKey, contentLength: record.contentLength)
            Usage.track("upload_completed", ["kind": record.isImage ? "image" : "video"])
            services.backgroundUploads.remove(capId: record.capId)
            center?.done(capId: record.capId, shareURL: record.shareUrl)
            await UploadActivities.shared.finish(capId: record.capId, phase: .done)
        } catch let error where error.isRetryable || error == .missingSession {
            // Keep the record; the next launch, unlock or foreground tries again.
            Self.log.notice("Upload completion deferred for \(record.capId, privacy: .public)")
        } catch {
            Usage.track("upload_failed", ["stage": "complete"])
            services.backgroundUploads.remove(capId: record.capId)
            let message = error.errorDescription ?? "The upload failed. Try again."
            center?.failed(capId: record.capId, message: message)
            await UploadActivities.shared.finish(capId: record.capId, phase: .failed, message: message)
        }
    }
}

/// iOS only starts Live Activities while Cap is on screen, so one starts the moment a file is picked,
/// keyed by upload job, and the Cap is attached once the server creates it.
@MainActor
final class UploadActivities {
    static let shared = UploadActivities()

    private static let log = Logger(subsystem: "so.cap.mobile", category: "live-activity")
    private var activities: [String: Activity<CapUploadAttributes>] = [:]
    private var capIds: [String: String] = [:]
    private var jobForCap: [String: String] = [:]
    private var lastSent: [String: (fraction: Double, at: Date)] = [:]
    /// Live Activity updates are budgeted; a stale date lets the widget say the upload is continuing
    /// in the background instead of showing a frozen percentage while Cap is suspended.
    private static let staleAfter: TimeInterval = 45

    func restore() {
        for activity in Activity<CapUploadAttributes>.activities {
            let id = activity.attributes.id
            activities[id] = activity
            if let capId = activity.content.state.capId {
                capIds[id] = capId
                jobForCap[capId] = id
            }
        }
    }

    func start(id: String, title: String, kind: CapUploadAttributes.Kind, phase: CapUploadAttributes.ContentState.Phase, capId: String? = nil) {
        guard activities[id] == nil else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            Self.log.notice("Live Activities are turned off for Cap")
            return
        }
        let attributes = CapUploadAttributes(id: id, title: title.isEmpty ? "Cap" : title, kind: kind)
        let state = CapUploadAttributes.ContentState(phase: phase, fraction: 0, capId: capId)
        do {
            activities[id] = try Activity.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: .now.addingTimeInterval(Self.staleAfter)),
                pushType: nil
            )
            if let capId {
                capIds[id] = capId
                jobForCap[capId] = id
            }
        } catch {
            // Optional: the in-app banner still shows progress.
            Self.log.error("Live Activity didn't start: \(String(describing: error), privacy: .public)")
        }
    }

    func link(id: String, capId: String) {
        capIds[id] = capId
        jobForCap[capId] = id
        send(id: id, phase: .uploading, fraction: 0, force: true)
    }

    func update(capId: String, phase: CapUploadAttributes.ContentState.Phase, fraction: Double) {
        send(id: jobForCap[capId] ?? capId, phase: phase, fraction: fraction, force: false)
    }

    func finish(capId: String, phase: CapUploadAttributes.ContentState.Phase, message: String? = nil) async {
        await finish(id: jobForCap[capId] ?? capId, phase: phase, message: message)
    }

    func update(id: String, phase: CapUploadAttributes.ContentState.Phase, fraction: Double) {
        send(id: id, phase: phase, fraction: fraction, force: false)
    }

    func finish(id: String, phase: CapUploadAttributes.ContentState.Phase, message: String? = nil, dismissImmediately: Bool = false) async {
        // ActivityKit's handle isn't annotated Sendable; ending it from the main actor is supported.
        guard let found = activities.removeValue(forKey: id) else { return }
        nonisolated(unsafe) let activity = found
        let capId = capIds.removeValue(forKey: id)
        if let capId { jobForCap[capId] = nil }
        lastSent[id] = nil
        let state = CapUploadAttributes.ContentState(phase: phase, fraction: phase == .done ? 1 : 0, message: message, capId: capId)
        let policy: ActivityUIDismissalPolicy = dismissImmediately ? .immediate : .after(.now.addingTimeInterval(phase == .done ? 15 * 60 : 60 * 60))
        await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: policy)
    }

    private func send(id: String, phase: CapUploadAttributes.ContentState.Phase, fraction: Double, force: Bool) {
        guard let found = activities[id] else { return }
        nonisolated(unsafe) let activity = found
        let now = Date.now
        if !force, let last = lastSent[id], phase == .uploading, fraction - last.fraction < 0.02, now.timeIntervalSince(last.at) < 2 {
            return
        }
        lastSent[id] = (fraction, now)
        let state = CapUploadAttributes.ContentState(phase: phase, fraction: fraction, capId: capIds[id])
        Task { await activity.update(ActivityContent(state: state, staleDate: now.addingTimeInterval(Self.staleAfter))) }
    }

    func endAll() async {
        let all = activities.values
        activities.removeAll()
        capIds.removeAll()
        jobForCap.removeAll()
        lastSent.removeAll()
        for found in Array(all) + Activity<CapUploadAttributes>.activities {
            nonisolated(unsafe) let activity = found
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }
}
