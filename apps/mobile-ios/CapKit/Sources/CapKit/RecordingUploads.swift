import Foundation
import os
import Synchronization

public enum RecordingUploadEvent: Sendable {
    case created(jobId: String, capId: String, shareUrl: String)
    case progress(jobId: String, uploaded: Int64, total: Int64)
    case completed(RecordingJob)
    case failed(RecordingJob, String)
}

public final class RecordingUploads: NSObject, Sendable, URLSessionDataDelegate {
    public static let sessionIdentifier = "so.cap.mobile.recordings"
    public static let screenSessionIdentifier = "so.cap.mobile.screen-recordings"
    static let handOffMarker = "handed-off"
    static let abandonedAfter: TimeInterval = 30
    private static let log = Logger(subsystem: "so.cap.mobile", category: "recordings")
    static let maxConcurrentUploads = 3
    /// Presigned links last 30 minutes; refetch a little before that.
    static let targetLifetime: TimeInterval = 25 * 60
    static let maxSegmentAttempts = 20

    private struct CachedTarget {
        let target: UploadTarget
        let fetchedAt: Date
    }

    private struct State {
        var jobs: [String: RecordingJob] = [:]
        var targets: [String: [String: CachedTarget]] = [:]
        var inFlight: [String: Set<String>] = [:]
        var busy: Set<String> = []
        var failures: [String: Int] = [:]
        var retryScheduled: Set<String> = []
        var dirty: Set<String> = []
        var persistScheduled = false
        var uploadedFiles: [String: [String]] = [:]

        mutating func removeJob(_ id: String) -> RecordingJob? {
            uploadedFiles[id] = nil
            return jobs.removeValue(forKey: id)
        }
        var finishEvents: (@Sendable () -> Void)?
    }

    private let state = Mutex(State())
    private let persistQueue = DispatchQueue(label: "so.cap.mobile.recording-uploads.persist", qos: .utility)
    private let session = Mutex<URLSession?>(nil)
    private let api: CapAPI
    private let engine: UploadEngine
    private let currentUserId: @Sendable () -> String?
    private let keepAlive: @Sendable () -> @Sendable () -> Void
    private let continuation: AsyncStream<RecordingUploadEvent>.Continuation
    public let events: AsyncStream<RecordingUploadEvent>
    public let root: URL
    private let adoptsHandOffs: Bool

    public init(
        root: URL,
        api: CapAPI,
        engine: UploadEngine,
        currentUserId: @escaping @Sendable () -> String?,
        keepAlive: @escaping @Sendable () -> @Sendable () -> Void = { {} },
        configuration: URLSessionConfiguration? = nil,
        adoptsHandOffs: Bool = false
    ) {
        self.root = root
        self.adoptsHandOffs = adoptsHandOffs
        self.api = api
        self.engine = engine
        self.currentUserId = currentUserId
        self.keepAlive = keepAlive
        (events, continuation) = AsyncStream.makeStream(of: RecordingUploadEvent.self, bufferingPolicy: .unbounded)
        super.init()
        Self.prepare(directory: root)
        let loaded = Self.loadJobs(in: root, adoptableOnly: adoptsHandOffs)
        state.withLock { $0.jobs = loaded }
        let session = URLSession(configuration: configuration ?? Self.makeConfiguration(), delegate: self, delegateQueue: nil)
        self.session.withLock { $0 = session }
    }

    public static func makeConfiguration(identifier: String = sessionIdentifier, sharedContainer: String? = nil) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.sharedContainerIdentifier = sharedContainer
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.allowsCellularAccess = true
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpMaximumConnectionsPerHost = maxConcurrentUploads
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        configuration.timeoutIntervalForResource = 60 * 60 * 24
        return configuration
    }

    // MARK: Recording lifecycle

    public func directory(for jobId: String) -> URL {
        let directory = root.appending(path: jobId, directoryHint: .isDirectory)
        Self.prepare(directory: directory)
        return directory
    }

    public func begin(_ job: RecordingJob) {
        _ = directory(for: job.id)
        state.withLock { $0.jobs[job.id] = job }
        persistNow(job.id)
        pump(job.id)
    }

    public func add(_ segment: RecordedSegment, to jobId: String) {
        let added = state.withLock { state -> Bool in
            // A writer's last segment can trail its finish callback by a moment.
            guard var job = state.jobs[jobId], job.phase == .recording || job.phase == .uploading else { return false }
            job.segments.removeAll { $0.subpath == segment.subpath }
            job.segments.append(segment)
            state.jobs[jobId] = job
            return true
        }
        guard added else { return }
        schedulePersist(jobId)
        pump(jobId)
    }

    public func finish(_ jobId: String, durationSeconds: Double) {
        let changed = state.withLock { state -> Bool in
            guard var job = state.jobs[jobId], job.phase == .recording else { return false }
            job.phase = .uploading
            job.durationSeconds = durationSeconds
            state.jobs[jobId] = job
            return true
        }
        guard changed else { return }
        persistNow(jobId)
        pump(jobId)
    }

    @discardableResult
    public func discard(_ jobId: String) async -> String? {
        let job = state.withLock { state -> RecordingJob? in
            state.inFlight[jobId] = nil
            state.targets[jobId] = nil
            return state.removeJob(jobId)
        }
        if let session = session.withLock({ $0 }) {
            for task in await session.allTasks where Self.parse(task.taskDescription)?.jobId == jobId {
                task.cancel()
            }
        }
        try? FileManager.default.removeItem(at: root.appending(path: jobId, directoryHint: .isDirectory))
        return job?.capId
    }

    public func discardAll() async {
        for id in state.withLock({ Array($0.jobs.keys) }) {
            await discard(id)
        }
    }

    public var jobs: [RecordingJob] {
        state.withLock { Array($0.jobs.values) }.sorted { $0.createdAt < $1.createdAt }
    }

    public func job(_ id: String) -> RecordingJob? {
        state.withLock { $0.jobs[id] }
    }

    public func resumeAll() async {
        let live: Set<String>
        if let session = session.withLock({ $0 }) {
            live = Set(await session.allTasks.compactMap { task in
                Self.parse(task.taskDescription).map { "\($0.jobId)|\($0.subpath)" }
            })
        } else {
            live = []
        }
        var empty: [String] = []
        let ids = state.withLock { state -> [String] in
            for (id, var job) in state.jobs where !job.isFinished {
                // Capture can't outlive the process. A recording still marked as capturing was cut
                // short by a crash; finish it with what reached the disk.
                if job.phase == .recording, !Self.isActive(id) {
                    guard let duration = Self.recordedDuration(job) else {
                        empty.append(id)
                        continue
                    }
                    job.phase = .uploading
                    job.durationSeconds = duration
                }
                if job.phase == .completing, !state.busy.contains("\(id)|complete") {
                    job.phase = .uploading
                }
                for index in job.segments.indices where job.segments[index].state == .uploading {
                    let key = "\(id)|\(job.segments[index].subpath)"
                    if !live.contains(key), state.inFlight[id]?.contains(job.segments[index].subpath) != true {
                        job.segments[index].state = .pending
                    }
                }
                state.jobs[id] = job
                state.failures[id] = 0
            }
            return state.jobs.values.filter { !$0.isFinished && !empty.contains($0.id) }.map(\.id)
        }
        for id in empty {
            if let capId = await discard(id).flatMap(CapID.init) {
                try? await api.deleteCap(capId)
            }
        }
        for id in ids {
            persistNow(id)
            pump(id)
        }
    }

    // MARK: Handing over between processes

    /// Lets the screen recorder end the moment the user stops instead of waiting for the last uploads.
    /// Returns the state the recording was handed over in, or nil when there was nothing left to hand over
    /// because it had already finished here.
    @discardableResult
    public func handOff(_ jobId: String, durationSeconds: Double?) async -> RecordingJob.Phase? {
        guard var job = state.withLock({ state -> RecordingJob? in
            state.inFlight[jobId] = nil
            state.targets[jobId] = nil
            return state.removeJob(jobId)
        }) else { return nil }
        let taken = job.phase
        if let session = session.withLock({ $0 }) {
            for task in await session.allTasks where Self.parse(task.taskDescription)?.jobId == jobId {
                task.cancel()
            }
        }
        if job.phase == .recording {
            job.phase = .uploading
            job.durationSeconds = durationSeconds ?? Self.recordedDuration(job)
        }
        if job.phase == .completing { job.phase = .uploading }
        for index in job.segments.indices where job.segments[index].state == .uploading {
            job.segments[index].state = .pending
        }
        Self.write(job, to: root)
        let directory = root.appending(path: jobId, directoryHint: .isDirectory)
        FileManager.default.createFile(atPath: directory.appending(path: Self.handOffMarker).path(percentEncoded: false), contents: nil)
        return taken
    }

    public func adopt() async {
        guard adoptsHandOffs else { return }
        let known = state.withLock { Set($0.jobs.keys) }
        let found = Self.loadJobs(in: root, adoptableOnly: true).filter { !known.contains($0.key) }
        guard !found.isEmpty else { return }
        state.withLock { state in
            for (id, job) in found where state.jobs[id] == nil { state.jobs[id] = job }
        }
        for job in found.values.sorted(by: { $0.createdAt < $1.createdAt }) {
            if let capId = job.capId, let shareUrl = job.shareUrl {
                continuation.yield(.created(jobId: job.id, capId: capId, shareUrl: shareUrl))
            }
        }
        await resumeAll()
    }

    static func isAdoptable(_ directory: URL, now: Date = .now) -> Bool {
        let manager = FileManager.default
        if manager.fileExists(atPath: directory.appending(path: handOffMarker).path(percentEncoded: false)) { return true }
        let items = (try? manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let latest = ([directory] + items).compactMap { try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate }.max() ?? .distantPast
        return now.timeIntervalSince(latest) > abandonedAfter
    }

    public func setFinishEventsHandler(_ handler: @escaping @Sendable () -> Void) {
        state.withLock { $0.finishEvents = handler }
    }

    // MARK: Active capture

    /// Anything else marked as recording is a leftover from a crash.
    private static let active = Mutex<Set<String>>([])

    public static func markActive(_ jobId: String, _ isActive: Bool) {
        active.withLock { set in
            if isActive { set.insert(jobId) } else { set.remove(jobId) }
        }
    }

    private static func isActive(_ jobId: String) -> Bool {
        active.withLock { $0.contains(jobId) }
    }

    public static func recordedDuration(_ job: RecordingJob) -> Double? {
        let total = job.segments.filter { $0.track == .video && !$0.isInitialization }.reduce(0) { $0 + $1.duration }
        return total > 0 ? total : nil
    }

    // MARK: Driving the upload

    private func pump(_ jobId: String) {
        guard let job = state.withLock({ $0.jobs[jobId] }), !job.isFinished else { return }
        guard let userId = currentUserId() else { return }
        guard userId == job.userId else {
            // Never upload into a different account than the one that recorded.
            Task { await discard(jobId) }
            return
        }
        guard let capId = job.capId.flatMap(CapID.init) else {
            create(job)
            return
        }
        fetchTargets(job, capId: capId)
        startUploads(jobId)
        completeIfReady(jobId, capId: capId)
    }

    private func claim(_ jobId: String, _ work: String) -> Bool {
        state.withLock { $0.busy.insert("\(jobId)|\(work)").inserted }
    }

    private func release(_ jobId: String, _ work: String) {
        _ = state.withLock { $0.busy.remove("\(jobId)|\(work)") }
    }

    private func create(_ job: RecordingJob) {
        guard claim(job.id, "create") else { return }
        let end = keepAlive()
        Task {
            defer { end() }
            do throws(CapAPIError) {
                // The server drops the extension; without one it would cut a time like "14.05".
                let created = try await api.createRecording(fileName: job.title + ".mp4", format: job.format, organizationId: job.organizationId, folderId: job.folderId)
                release(job.id, "create")
                let stored = state.withLock { state -> Bool in
                    guard var current = state.jobs[job.id] else { return false }
                    current.capId = created.id
                    current.shareUrl = created.shareUrl
                    state.jobs[job.id] = current
                    state.failures[job.id] = 0
                    return true
                }
                guard stored else {
                    // Discarded while the Cap was being created.
                    if let capId = CapID(created.id) { try? await api.deleteCap(capId) }
                    return
                }
                persistNow(job.id)
                continuation.yield(.created(jobId: job.id, capId: created.id, shareUrl: created.shareUrl))
                pump(job.id)
            } catch {
                release(job.id, "create")
                handle(error, jobId: job.id)
            }
        }
    }

    private func knownTargets(_ jobId: String, now: Date = .now) -> Set<String> {
        state.withLock { state in
            Set((state.targets[jobId] ?? [:]).filter { now.timeIntervalSince($0.value.fetchedAt) < Self.targetLifetime }.keys)
        }
    }

    private func fetchTargets(_ job: RecordingJob, capId: CapID) {
        // Claimed before planning: planned from links a batch still in flight is about to add, the
        // same batch would be asked for twice.
        guard claim(job.id, "targets") else { return }
        let current = state.withLock { $0.jobs[job.id] } ?? job
        let wanted = RecordingTargetPlanner.subpathsToRequest(for: current, known: knownTargets(job.id))
        guard !wanted.isEmpty else {
            release(job.id, "targets")
            return
        }
        let end = keepAlive()
        Task {
            defer { end() }
            do throws(CapAPIError) {
                let targets = try await api.recordingUploadTargets(capId, subpaths: wanted)
                let now = Date.now
                state.withLock { state in
                    var cached = state.targets[job.id] ?? [:]
                    for (subpath, target) in targets { cached[subpath] = CachedTarget(target: target, fetchedAt: now) }
                    state.targets[job.id] = cached
                    state.failures[job.id] = 0
                }
                release(job.id, "targets")
                pump(job.id)
            } catch {
                release(job.id, "targets")
                handle(error, jobId: job.id)
            }
        }
    }

    private func startUploads(_ jobId: String) {
        guard let session = session.withLock({ $0 }) else { return }
        let directory = root.appending(path: jobId, directoryHint: .isDirectory)
        let now = Date.now
        let picked = state.withLock { state -> [(RecordedSegment, UploadTarget)] in
            guard var job = state.jobs[jobId], !job.isFinished else { return [] }
            var running = state.inFlight[jobId] ?? []
            let targets = state.targets[jobId] ?? [:]
            var picked: [(RecordedSegment, UploadTarget)] = []
            // Init segments first, then oldest first, so storage fills in order. Only pending ones are
            // considered: an hour-long recording has thousands of segments, nearly all uploaded.
            let order = job.segments.indices.filter { job.segments[$0].state == .pending }.sorted { job.segments[$0].index < job.segments[$1].index }
            for index in order where running.count < Self.maxConcurrentUploads {
                let segment = job.segments[index]
                guard segment.state == .pending, !running.contains(segment.subpath),
                      let cached = targets[segment.subpath], now.timeIntervalSince(cached.fetchedAt) < Self.targetLifetime
                else { continue }
                job.segments[index].state = .uploading
                running.insert(segment.subpath)
                picked.append((job.segments[index], cached.target))
            }
            state.inFlight[jobId] = running
            state.jobs[jobId] = job
            return picked
        }
        for (segment, target) in picked {
            do {
                let prepared = try engine.prepareRequest(
                    file: directory.appending(path: segment.fileName),
                    fileName: segment.fileName,
                    contentType: "video/mp4",
                    size: segment.bytes,
                    target: target,
                    workDirectory: directory
                )
                let task = session.uploadTask(with: prepared.request, fromFile: prepared.bodyFile)
                task.taskDescription = "\(jobId)|\(segment.subpath)"
                task.countOfBytesClientExpectsToSend = segment.bytes
                task.countOfBytesClientExpectsToReceive = 1024
                task.resume()
            } catch .fileUnavailable {
                fail(jobId, message: RecordingError.missingSegments.errorDescription ?? "")
                return
            } catch {
                segmentFinished(jobId, subpath: segment.subpath, status: nil)
            }
        }
    }

    private func completeIfReady(_ jobId: String, capId: CapID) {
        guard let job = state.withLock({ $0.jobs[jobId] }), job.isReadyToComplete else { return }
        let completion: RecordingCompletion
        do {
            completion = try job.completion()
        } catch {
            fail(jobId, message: error.errorDescription ?? "")
            return
        }
        guard claim(jobId, "complete") else { return }
        update(jobId) { $0.phase = .completing }
        let end = keepAlive()
        Task {
            defer { end() }
            do throws(CapAPIError) {
                try await api.completeRecording(capId, completion)
                release(jobId, "complete")
                guard let done = state.withLock({ state -> RecordingJob? in
                    guard var job = state.removeJob(jobId) else { return nil }
                    job.phase = .completed
                    state.targets[jobId] = nil
                    state.inFlight[jobId] = nil
                    state.failures[jobId] = nil
                    return job
                }) else { return }
                try? FileManager.default.removeItem(at: root.appending(path: jobId, directoryHint: .isDirectory))
                continuation.yield(.completed(done))
            } catch {
                release(jobId, "complete")
                if error == .forbidden {
                    fail(jobId, message: RecordingError.tooLong.errorDescription ?? "")
                    return
                }
                update(jobId) { $0.phase = .uploading }
                handle(error, jobId: jobId)
            }
        }
    }

    private func handle(_ error: CapAPIError, jobId: String) {
        Self.log.error("Recording request failed: \(String(describing: error), privacy: .public)")
        if error.isRetryable || error == .missingSession {
            scheduleRetry(jobId)
        } else {
            fail(jobId, message: error.errorDescription ?? "The recording couldn't be uploaded.")
        }
    }

    private func scheduleRetry(_ jobId: String) {
        let delay = state.withLock { state -> Double? in
            guard state.retryScheduled.insert(jobId).inserted else { return nil }
            let failures = (state.failures[jobId] ?? 0) + 1
            state.failures[jobId] = failures
            // 0.5, 1, 2, 4… seconds: a quick second try covers the server's own short hand-offs.
            return min(30, 0.5 * pow(2, Double(min(failures, 7) - 1)))
        }
        guard let delay else { return }
        Task {
            try? await Task.sleep(for: .seconds(delay))
            _ = state.withLock { $0.retryScheduled.remove(jobId) }
            pump(jobId)
        }
    }

    private func fail(_ jobId: String, message: String) {
        guard let failed = state.withLock({ state -> RecordingJob? in
            guard var job = state.jobs[jobId], !job.isFinished else { return nil }
            job.phase = .failed
            job.failure = message
            state.jobs[jobId] = job
            return job
        }) else { return }
        persistNow(jobId)
        continuation.yield(.failed(failed, message))
    }

    public func dismissFailed(_ jobId: String) async {
        guard state.withLock({ $0.jobs[jobId]?.phase == .failed }) else { return }
        await discard(jobId)
    }

    private func update(_ jobId: String, _ change: (inout RecordingJob) -> Void) {
        let found = state.withLock { state -> Bool in
            guard var job = state.jobs[jobId] else { return false }
            change(&job)
            state.jobs[jobId] = job
            return true
        }
        if found { persistNow(jobId) }
    }

    private func segmentFinished(_ jobId: String, subpath: String, status: Int?) {
        let succeeded = status.map { (200..<300).contains($0) } ?? false
        let outcome = state.withLock { state -> (uploaded: Int64, total: Int64, file: String?, giveUp: Bool)? in
            state.inFlight[jobId]?.remove(subpath)
            guard var job = state.jobs[jobId], let index = job.segments.firstIndex(where: { $0.subpath == subpath }) else { return nil }
            var giveUp = false
            var file: String?
            if succeeded {
                job.segments[index].state = .uploaded
                file = job.segments[index].fileName
            } else {
                job.segments[index].state = .pending
                job.segments[index].attempts += 1
                giveUp = job.segments[index].attempts >= Self.maxSegmentAttempts
                // Storage refuses expired or already-used links; get a fresh one.
                if let status, (400..<500).contains(status) {
                    state.targets[jobId]?[subpath] = nil
                }
            }
            state.jobs[jobId] = job
            return (job.uploadedBytes, job.totalBytes, file, giveUp)
        }
        // A discarded recording's cancelled tasks land here too.
        guard let outcome else { return }
        if let file = outcome.file {
            // Storage has it; the file goes once job.json says so, or a crash before then would find it missing.
            state.withLock { $0.uploadedFiles[jobId, default: []].append(file) }
        }
        continuation.yield(.progress(jobId: jobId, uploaded: outcome.uploaded, total: outcome.total))
        schedulePersist(jobId)
        if outcome.giveUp {
            fail(jobId, message: "Storage kept refusing part of the recording. Try again later.")
        } else if succeeded {
            pump(jobId)
        } else {
            scheduleRetry(jobId)
        }
    }

    // MARK: URLSession delegate

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        guard let (jobId, subpath) = Self.parse(task.taskDescription) else { return }
        let status = error == nil ? (task.response as? HTTPURLResponse)?.statusCode : nil
        segmentFinished(jobId, subpath: subpath, status: status)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let handler = state.withLock { state -> (@Sendable () -> Void)? in
            defer { state.finishEvents = nil }
            return state.finishEvents
        }
        if let handler { DispatchQueue.main.async(execute: handler) }
    }

    static func parse(_ description: String?) -> (jobId: String, subpath: String)? {
        guard let description, let split = description.firstIndex(of: "|") else { return nil }
        return (String(description[..<split]), String(description[description.index(after: split)...]))
    }

    // MARK: Storage

    private func persistNow(_ jobId: String) {
        persistQueue.sync { writeSnapshot([jobId]) }
    }

    /// Runs on `persistQueue` only, so writes land in order and an older snapshot never replaces a newer one.
    private func writeSnapshot(_ ids: Set<String>?) {
        let snapshot = state.withLock { state -> [(RecordingJob, [String])] in
            let chosen = ids ?? state.dirty
            state.dirty.subtract(chosen)
            if ids == nil { state.persistScheduled = false }
            return chosen.compactMap { id in
                guard let job = state.jobs[id] else { return nil }
                return (job, state.uploadedFiles.removeValue(forKey: id) ?? [])
            }
        }
        for (job, files) in snapshot {
            let directory = root.appending(path: job.id, directoryHint: .isDirectory)
            if Self.write(job, to: root) {
                for file in files { try? FileManager.default.removeItem(at: directory.appending(path: file)) }
            } else if !files.isEmpty {
                state.withLock { $0.uploadedFiles[job.id, default: []].append(contentsOf: files) }
            }
        }
    }

    /// Segments land every second or so; coalesce their writes. A crash loses at most the last few
    /// seconds of bookkeeping, and a recovered recording simply ends a little earlier.
    private func schedulePersist(_ jobId: String) {
        let delay = state.withLock { state -> Double? in
            state.dirty.insert(jobId)
            guard !state.persistScheduled else { return nil }
            state.persistScheduled = true
            // Each write re-encodes every segment; long recordings write less often.
            return min(5, max(1, Double(state.jobs[jobId]?.segments.count ?? 0) / 300))
        }
        guard let delay else { return }
        persistQueue.asyncAfter(deadline: .now() + delay) { [self] in writeSnapshot(nil) }
    }

    @discardableResult
    private static func write(_ job: RecordingJob, to root: URL) -> Bool {
        guard let data = try? CapJSON.encoder().encode(job) else { return false }
        let directory = root.appending(path: job.id, directoryHint: .isDirectory)
        guard FileManager.default.fileExists(atPath: directory.path(percentEncoded: false)) else { return false }
        do {
            try data.write(to: directory.appending(path: "job.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return true
        } catch {
            return false
        }
    }

    private static func loadJobs(in root: URL, adoptableOnly: Bool = false) -> [String: RecordingJob] {
        guard let items = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return [:] }
        var jobs: [String: RecordingJob] = [:]
        for item in items {
            let adoptable = isAdoptable(item)
            if adoptableOnly, !adoptable { continue }
            guard let data = try? Data(contentsOf: item.appending(path: "job.json")),
                  let job = try? CapJSON.decoder().decode(RecordingJob.self, from: data),
                  job.id == item.lastPathComponent
            else {
                // A folder without a readable record can never be uploaded. A fresh one may be a
                // recording whose record is about to be written.
                if adoptable { try? FileManager.default.removeItem(at: item) }
                continue
            }
            jobs[job.id] = job
        }
        return jobs
    }

    private static func prepare(directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = directory
        try? url.setResourceValues(values)
    }
}
