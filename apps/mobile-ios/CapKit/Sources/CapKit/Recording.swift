import Foundation

public enum RecordingTrack: String, Codable, Sendable, CaseIterable {
    case video
    case audio
}

/// One fragmented MP4 piece of a recording, written to disk as soon as the encoder cuts it.
public struct RecordedSegment: Codable, Sendable, Hashable {
    public enum State: String, Codable, Sendable {
        case pending
        case uploading
        case uploaded
    }

    public let track: RecordingTrack
    /// 0 is the initialization segment; media segments count from 1.
    public let index: Int
    public let duration: Double
    public let bytes: Int64
    public var state: State
    public var attempts: Int

    public init(track: RecordingTrack, index: Int, duration: Double, bytes: Int64) {
        self.track = track
        self.index = index
        self.duration = duration
        self.bytes = bytes
        state = .pending
        attempts = 0
    }

    public var isInitialization: Bool { index == 0 }
    public var subpath: String { Self.subpath(track: track, index: index) }
    public var fileName: String {
        isInitialization ? "\(track.rawValue)_init.mp4" : String(format: "%@_%06d.m4s", track.rawValue, index)
    }

    public static func subpath(track: RecordingTrack, index: Int) -> String {
        index == 0
            ? "segments/\(track.rawValue)/init.mp4"
            : String(format: "segments/%@/segment_%03d.m4s", track.rawValue, index)
    }
}

/// A recording from the moment capture starts until Cap has it, persisted so a relaunch can finish it.
public struct RecordingJob: Codable, Sendable, Identifiable {
    public enum Phase: String, Codable, Sendable {
        /// Still capturing; segments keep arriving.
        case recording
        /// Capture ended; the last segments are uploading.
        case uploading
        /// Every segment is in storage and Cap is being told to process it.
        case completing
        case completed
        case failed
    }

    public struct Format: Codable, Sendable, Hashable {
        public let width: Int
        public let height: Int
        public let fps: Int

        public init(width: Int, height: Int, fps: Int) {
            self.width = width
            self.height = height
            self.fps = fps
        }
    }

    /// Local id; names the folder the segments are written to.
    public let id: String
    public let userId: String
    public let title: String
    public let format: Format
    public let organizationId: String?
    public let folderId: String?
    public let hasAudio: Bool
    public let createdAt: Date
    public var capId: String?
    public var shareUrl: String?
    public var phase: Phase
    public var segments: [RecordedSegment]
    public var durationSeconds: Double?
    public var failure: String?

    public init(id: String = UUID().uuidString, userId: String, title: String, format: Format, organizationId: String?, folderId: String?, hasAudio: Bool, createdAt: Date = .now) {
        self.id = id
        self.userId = userId
        self.title = title
        self.format = format
        self.organizationId = organizationId
        self.folderId = folderId
        self.hasAudio = hasAudio
        self.createdAt = createdAt
        phase = .recording
        segments = []
    }

    public var tracks: [RecordingTrack] { hasAudio ? [.video, .audio] : [.video] }
    public var totalBytes: Int64 { segments.reduce(0) { $0 + $1.bytes } }
    public var uploadedBytes: Int64 { segments.reduce(0) { $0 + ($1.state == .uploaded ? $1.bytes : 0) } }
    public var isFinished: Bool { phase == .completed || phase == .failed }

    public var isReadyToComplete: Bool {
        phase == .uploading && capId != nil && durationSeconds != nil && !segments.isEmpty && segments.allSatisfy { $0.state == .uploaded }
    }

    /// What Cap needs to stitch the segments together, checked against the server's own rules
    /// so a broken recording fails here with a clear reason instead of as a 400.
    public func completion() throws(RecordingError) -> RecordingCompletion {
        guard let durationSeconds, durationSeconds > 0 else { throw .empty }
        func media(_ track: RecordingTrack) throws(RecordingError) -> [RecordingCompletion.Segment] {
            let items = segments.filter { $0.track == track && !$0.isInitialization }.sorted { $0.index < $1.index }
            guard items.isEmpty || segments.contains(where: { $0.track == track && $0.isInitialization }) else { throw .missingSegments }
            for (position, item) in items.enumerated() where item.index != position + 1 {
                throw .missingSegments
            }
            return items.map { RecordingCompletion.Segment(index: $0.index, duration: min(10, max(0.001, $0.duration))) }
        }
        let video = try media(.video)
        guard !video.isEmpty else { throw .empty }
        return RecordingCompletion(
            durationSeconds: durationSeconds,
            totalBytes: totalBytes,
            videoSegments: video,
            audioSegments: try media(.audio)
        )
    }
}

public enum RecordingError: Error, Sendable, Equatable, LocalizedError {
    case empty
    case missingSegments
    case tooLong
    case rejected(String)

    public var errorDescription: String? {
        switch self {
        case .empty: "Nothing was recorded."
        case .missingSegments: "Part of the recording is missing, so it can't be finished."
        case .tooLong: "Recordings on the free plan can be up to 5 minutes. Upgrade to Cap Pro for longer ones."
        case let .rejected(message): message
        }
    }
}

public struct RecordingCompletion: Codable, Sendable, Equatable {
    public struct Segment: Codable, Sendable, Equatable {
        public let index: Int
        public let duration: Double
    }

    public let durationSeconds: Double
    public let totalBytes: Int64
    public let videoSegments: [Segment]
    public let audioSegments: [Segment]
}

public struct RecordingCreated: Codable, Sendable, Hashable {
    public let id: String
    public let shareUrl: String
}

public enum RecordingLimits {
    /// Matches `mobileFreeRecordingDurationSeconds` on the server.
    public static let freeDuration: TimeInterval = 5 * 60
    public static let segmentDuration: TimeInterval = 2
}

/// Decides which upload links to ask Cap for. Subpaths are predictable, so links for the next few
/// segments are fetched ahead of time and a finished segment can start uploading immediately,
/// with one small request every ~10 seconds of recording instead of one per segment.
/// Links that end up unused cost nothing on S3; on Google Drive they reserve a placeholder each.
public enum RecordingTargetPlanner {
    public static let lookahead = 8
    public static let maxBatch = 25
    /// Fetch again once fewer than this many future links are left for a track.
    public static let runway = 3

    public static func subpathsToRequest(for job: RecordingJob, known: Set<String>) -> [String] {
        var batch: [String] = []
        var seen = Set<String>()
        func add(_ subpath: String) {
            guard !known.contains(subpath), seen.insert(subpath).inserted else { return }
            batch.append(subpath)
        }

        let missing = job.segments.filter { $0.state != .uploaded && !known.contains($0.subpath) }
        var lowRunway = false
        var upcoming: [String] = []
        if job.phase == .recording {
            for track in job.tracks {
                let next = (job.segments.filter { $0.track == track }.map(\.index).max() ?? -1) + 1
                let ahead = (next..<(next + lookahead)).map { RecordedSegment.subpath(track: track, index: $0) }
                if ahead.prefix(runway).contains(where: { !known.contains($0) }) { lowRunway = true }
                upcoming.append(contentsOf: ahead)
            }
        }
        guard !missing.isEmpty || lowRunway else { return [] }
        missing.forEach { add($0.subpath) }
        upcoming.forEach(add)
        return Array(batch.prefix(maxBatch))
    }
}
