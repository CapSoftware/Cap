#if canImport(ActivityKit) && os(iOS)
import ActivityKit
import Foundation

/// The Live Activity shown in the Dynamic Island and on the lock screen while a Cap uploads or imports.
/// It starts as soon as the user picks a file, before the Cap exists, so `capId` arrives later in the state.
public struct CapUploadAttributes: ActivityAttributes {
    public enum Kind: String, Codable, Hashable, Sendable {
        case video, image, loom, recording
    }

    public struct ContentState: Codable, Hashable, Sendable {
        public enum Phase: String, Codable, Hashable, Sendable {
            case preparing, uploading, importing, finishing, done, failed
        }

        public var phase: Phase
        public var fraction: Double
        public var message: String?
        public var capId: String?

        public init(phase: Phase, fraction: Double = 0, message: String? = nil, capId: String? = nil) {
            self.phase = phase
            self.fraction = min(max(fraction, 0), 1)
            self.message = message
            self.capId = capId
        }

        public var deepLink: URL? {
            capId.flatMap(CapID.init).flatMap { URL(string: "cap://s/\($0.rawValue)") }
        }
    }

    /// Identifies the upload job, not the Cap.
    public let id: String
    public let title: String
    public let kind: Kind

    public init(id: String, title: String, kind: Kind) {
        self.id = id
        self.title = title
        self.kind = kind
    }
}

/// The Live Activity shown while the screen is recorded, so it can be stopped from anywhere.
public struct ScreenRecordingAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable, Sendable {
        public var isStopping: Bool

        public init(isStopping: Bool = false) {
            self.isStopping = isStopping
        }
    }

    public let startedAt: Date
    public let withCamera: Bool

    public init(startedAt: Date, withCamera: Bool) {
        self.startedAt = startedAt
        self.withCamera = withCamera
    }
}
#endif
