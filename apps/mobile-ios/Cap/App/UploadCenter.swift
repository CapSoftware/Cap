import AVFoundation
import CapKit
import Foundation
import Observation
import os
import UIKit
import UniformTypeIdentifiers

@MainActor
@Observable
final class UploadJob: Identifiable {
    enum Phase: Equatable {
        case preparing
        case uploading(fraction: Double)
        case finishing
        case done(shareURL: String, capId: String)
        case failed(String)
    }

    let id = UUID()
    let fileName: String
    var phase: Phase = .preparing
    var capId: String?
    var shareURL: String?

    init(fileName: String) {
        self.fileName = fileName
    }

    var isActive: Bool {
        switch phase {
        case .preparing, .uploading, .finishing: true
        case .done, .failed: false
        }
    }

    var fraction: Double {
        switch phase {
        case .preparing: 0
        case let .uploading(fraction): fraction
        case .finishing, .done: 1
        case .failed: 0
        }
    }
}

struct PreparedVideo: Sendable {
    let fileURL: URL
    let fileName: String
    let contentType: String
    let size: Int64
    let duration: Double?
    let width: Int?
    let height: Int?
    let fps: Double?

    var isImage: Bool { contentType.hasPrefix("image/") }
}

enum UploadPreparationError: LocalizedError {
    case unsupported
    case unreadable
    case empty

    var errorDescription: String? {
        switch self {
        case .unsupported: "That file isn't a video or photo Cap can upload."
        case .unreadable: "That file couldn't be read. Try another one."
        case .empty: "That file is empty."
        }
    }
}

@MainActor
@Observable
final class UploadCenter {
    private static let log = Logger(subsystem: "so.cap.mobile", category: "uploads")
    private(set) var jobs: [UploadJob] = []
    @ObservationIgnored weak var session: SessionModel?
    @ObservationIgnored private let services: AppServices
    @ObservationIgnored private var tasks: [UUID: Task<Void, Never>] = [:]

    init(services: AppServices, userId: String) {
        self.services = services
        // Uploads keep running in the background session across launches; show the ones still going.
        for record in services.backgroundUploads.records where record.userId == userId {
            let job = UploadJob(fileName: record.title)
            job.capId = record.capId
            job.shareURL = record.shareUrl
            job.phase = record.state == .uploaded ? .finishing : .uploading(fraction: 0)
            jobs.append(job)
        }
        BackgroundUploadCoordinator.shared.center = self
    }

    var visibleJob: UploadJob? {
        jobs.last(where: \.isActive) ?? jobs.last
    }

    var hasActiveUploads: Bool { jobs.contains(where: \.isActive) }

    func dismiss(_ job: UploadJob) {
        guard !job.isActive else { return }
        jobs.removeAll { $0.id == job.id }
    }

    /// Transfers already handed to the background session are cancelled by sign out.
    func cancelAll() {
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
        jobs.removeAll()
    }

    func enqueue(displayName: String, folderId: String?, kind: CapUploadAttributes.Kind = .video, prepare: @escaping @Sendable () async throws -> PreparedVideo) {
        let job = UploadJob(fileName: displayName)
        jobs.append(job)
        // Must start now, while Cap is on screen; iOS refuses once the user has switched away.
        UploadActivities.shared.start(id: job.id.uuidString, title: displayName, kind: kind, phase: .preparing)
        let task = Task { [weak self] in
            guard let self else { return }
            await self.run(job, folderId: folderId, prepare: prepare)
        }
        tasks[job.id] = task
    }

    // MARK: Background session callbacks

    private func job(for capId: String) -> UploadJob? {
        jobs.last { $0.capId == capId }
    }

    func progress(capId: String, fraction: Double) {
        guard let job = job(for: capId), job.isActive else { return }
        job.phase = .uploading(fraction: fraction)
    }

    func finishing(capId: String) {
        job(for: capId)?.phase = .finishing
    }

    func done(capId: String, shareURL: String) {
        guard let job = job(for: capId) else { return }
        job.phase = .done(shareURL: shareURL, capId: capId)
        guard let session else { return }
        session.toasts.show("Upload complete", systemImage: "arrow.up.circle.fill")
        PushNotifications.shared.askAfterFirstUpload()
        session.invalidateLibraries()
        if let key = session.currentLibraryKey {
            Task { await session.library(for: key).refresh() }
        }
    }

    func failed(capId: String, message: String) {
        job(for: capId)?.phase = .failed(message)
    }

    // MARK: Starting uploads

    private func run(_ job: UploadJob, folderId: String?, prepare: @escaping @Sendable () async throws -> PreparedVideo) async {
        // Preparing and creating the Cap need the app; the transfer itself runs in the background session.
        let assertion = BackgroundAssertion()
        assertion.begin { [weak self, weak job] in
            guard let job, job.capId == nil else { return }
            self?.tasks[job.id]?.cancel()
            job.phase = .failed("Cap went to the background before the upload could start. Try again.")
        }
        defer {
            tasks[job.id] = nil
            assertion.end()
        }

        var prepared: PreparedVideo?
        var handedOff = false
        defer {
            if !handedOff, let prepared { try? FileManager.default.removeItem(at: prepared.fileURL) }
        }
        do {
            let video = try await Task.detached(priority: .userInitiated) { try await prepare() }.value
            prepared = video
            guard video.size > 0 else { throw UploadPreparationError.empty }
            guard let session else { return }
            let created = try await services.api.createUpload(UploadRequest(
                organizationId: session.organizationId,
                folderId: folderId,
                fileName: video.fileName,
                contentType: video.contentType,
                contentLength: video.size,
                durationSeconds: video.duration,
                width: video.width,
                height: video.height,
                fps: video.fps
            ))
            guard CapID(created.id) != nil else { throw CapAPIError.invalidResponse }
            let request = try services.uploads.prepareRequest(
                file: video.fileURL,
                fileName: video.fileName,
                contentType: video.contentType,
                size: video.size,
                target: created.upload,
                workDirectory: services.backgroundUploads.directory
            )
            let record = PendingUpload(
                capId: created.id,
                shareUrl: created.shareUrl,
                rawFileKey: created.rawFileKey,
                contentLength: video.size,
                title: job.fileName,
                userId: session.credentials.userId,
                isImage: video.isImage,
                sourceFile: video.fileURL.path(percentEncoded: false),
                temporaryBody: request.temporaryBody?.path(percentEncoded: false)
            )
            services.backgroundUploads.start(request, record: record)
            handedOff = true
            job.capId = created.id
            job.shareURL = created.shareUrl
            job.phase = .uploading(fraction: 0)
            UploadActivities.shared.link(id: job.id.uuidString, capId: created.id)
            BackgroundUploadCoordinator.shared.keepProgressLive(capId: created.id)
            session.invalidateLibraries()
        } catch {
            Self.log.error("Upload failed before handoff: \(String(describing: error), privacy: .public)")
            if !Task.isCancelled { Usage.track("upload_failed", ["stage": "prepare"]) }
            let message = Self.message(for: error)
            if !Task.isCancelled {
                job.phase = .failed(message)
            }
            await UploadActivities.shared.finish(id: job.id.uuidString, phase: .failed, message: message)
        }
    }

    private static func message(for error: any Error) -> String {
        if let error = error as? LocalizedError, let description = error.errorDescription { return description }
        return "The upload failed. Try again."
    }

    /// Staged files live with the background session so they survive Cap being suspended or quit.
    nonisolated static func stagingURL(extension ext: String) throws -> URL {
        let directory = AppServices.uploadsDirectory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appending(path: "\(UUID().uuidString).\(ext)")
    }

    nonisolated static func prepareVideo(copying source: URL, suggestedName: String?, securityScoped: Bool, moveInsteadOfCopy: Bool = false) async throws -> PreparedVideo {
        let accessing = securityScoped && source.startAccessingSecurityScopedResource()
        defer { if accessing { source.stopAccessingSecurityScopedResource() } }

        let type = UTType(filenameExtension: source.pathExtension) ?? .movie
        if type.conforms(to: .image) {
            return try prepareImage(at: source, suggestedName: suggestedName, removeSource: moveInsteadOfCopy)
        }
        guard type.conforms(to: .movie) || type.conforms(to: .video) else { throw UploadPreparationError.unsupported }
        let ext = type.preferredFilenameExtension ?? "mp4"
        let destination = try stagingURL(extension: ext)
        do {
            if moveInsteadOfCopy {
                try FileManager.default.moveItem(at: source, to: destination)
            } else {
                // APFS clones the file, so this is near instant for videos on the same volume.
                try FileManager.default.copyItem(at: source, to: destination)
            }
        } catch {
            if moveInsteadOfCopy { try? FileManager.default.removeItem(at: source) }
            throw UploadPreparationError.unreadable
        }
        let baseName = (suggestedName ?? source.deletingPathExtension().lastPathComponent)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let fileName = "\(baseName.isEmpty ? "Video" : String(baseName.prefix(120))).\(ext)"
        return try await probe(destination, fileName: fileName, contentType: type.preferredMIMEType ?? "video/mp4")
    }

    /// Re-encoding to JPEG drops location and camera metadata.
    nonisolated static func prepareImage(at source: URL, suggestedName: String?, removeSource: Bool) throws -> PreparedVideo {
        defer { if removeSource { try? FileManager.default.removeItem(at: source) } }
        let jpeg: Data
        do {
            jpeg = try ImageCoding.encodeScreenshot(fileURL: source)
        } catch {
            throw UploadPreparationError.unreadable
        }
        let destination = try stagingURL(extension: "jpg")
        try jpeg.write(to: destination, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        let baseName = (suggestedName ?? source.deletingPathExtension().lastPathComponent).trimmingCharacters(in: .whitespacesAndNewlines)
        let fileName = "\(baseName.isEmpty ? "Photo" : String(baseName.prefix(120))).jpg"
        return PreparedVideo(fileURL: destination, fileName: fileName, contentType: "image/jpeg", size: Int64(jpeg.count), duration: nil, width: nil, height: nil, fps: nil)
    }

    nonisolated static func probe(_ url: URL, fileName: String, contentType: String) async throws -> PreparedVideo {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path(percentEncoded: false))
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        let asset = AVURLAsset(url: url)
        var duration: Double?
        var width: Int?
        var height: Int?
        var fps: Double?
        if let time = try? await asset.load(.duration), time.isNumeric {
            duration = time.seconds
        }
        if let track = try? await asset.loadTracks(withMediaType: .video).first {
            if let (size, transform) = try? await track.load(.naturalSize, .preferredTransform) {
                let rect = CGRect(origin: .zero, size: size).applying(transform)
                width = Int(abs(rect.width).rounded())
                height = Int(abs(rect.height).rounded())
            }
            if let rate = try? await track.load(.nominalFrameRate), rate > 0 {
                fps = Double(rate)
            }
        }
        guard duration != nil || width != nil else {
            try? FileManager.default.removeItem(at: url)
            throw UploadPreparationError.unreadable
        }
        return PreparedVideo(fileURL: url, fileName: fileName, contentType: contentType.hasPrefix("video/") ? contentType : "video/mp4", size: size, duration: duration, width: width, height: height, fps: fps)
    }
}

nonisolated final class ProgressReporter: Sendable {
    private let api: CapAPI
    private let capId: CapID
    private let lastReport = OSAllocatedUnfairLockBox()

    init(api: CapAPI, capId: CapID) {
        self.api = api
        self.capId = capId
    }

    func report(sent: Int64, total: Int64) {
        guard lastReport.shouldReport(now: Date.now.timeIntervalSince1970, finished: sent >= total) else { return }
        let api = api
        let capId = capId
        Task.detached(priority: .utility) {
            try? await api.updateUploadProgress(capId, uploaded: sent, total: total)
        }
    }
}

nonisolated final class OSAllocatedUnfairLockBox: Sendable {
    private let lock = OSAllocatedUnfairLock(initialState: 0.0)

    func shouldReport(now: Double, finished: Bool) -> Bool {
        lock.withLock { last in
            // Each report is a database write; every 5 seconds keeps the dashboard live without load.
            guard finished || now - last >= 5 else { return false }
            last = now
            return true
        }
    }
}

@MainActor
final class BackgroundAssertion {
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    func begin(onExpiration: @escaping @MainActor () -> Void) {
        identifier = UIApplication.shared.beginBackgroundTask(withName: "Cap upload") { [weak self] in
            MainActor.assumeIsolated {
                onExpiration()
                self?.end()
            }
        }
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}

nonisolated final class FractionThrottle: Sendable {
    private let lock = OSAllocatedUnfairLock(initialState: -1.0)

    func shouldPublish(_ fraction: Double) -> Bool {
        lock.withLock { last in
            guard fraction >= 1 || fraction - last >= 0.005 else { return false }
            last = fraction
            return true
        }
    }
}
