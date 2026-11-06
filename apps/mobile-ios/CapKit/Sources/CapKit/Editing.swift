import Foundation

/// A stretch of the video to keep, in seconds of the video as it is now.
public struct EditRange: Codable, Sendable, Hashable {
    public var start: Double
    public var end: Double

    public init(start: Double, end: Double) {
        self.start = start
        self.end = end
    }

    public var duration: Double { end - start }
}

/// Whether the owner can edit a Cap right now, from `GET /api/mobile/caps/:id/edit`.
public struct CapEditState: Codable, Sendable, Hashable {
    public enum Status: String, UnknownCaseDecodable {
        case available
        case proRequired = "pro_required"
        case notEditable = "not_editable"
        case busy

        public static let unknownCase = Status.notEditable
    }

    public let status: Status
    /// The length of the video as it is now; edits are made against this.
    public let duration: Double
    public let hasEdits: Bool

    public init(status: Status, duration: Double, hasEdits: Bool) {
        self.status = status
        self.duration = duration
        self.hasEdits = hasEdits
    }
}

/// The edit as a list of kept clips in source order. "Output" time is the edited video's own timeline; "source"
/// time is the video as it is now. Every operation returns a new timeline, so undo is a stack of values.
public struct EditTimeline: Sendable, Hashable {
    /// Clips shorter than this can't be made; the web editor and media server use the same floor.
    public static let minimumClip: Double = 0.1

    public let sourceDuration: Double
    public private(set) var clips: [EditRange]

    public init(sourceDuration: Double) {
        self.sourceDuration = max(0, sourceDuration)
        clips = self.sourceDuration > 0 ? [EditRange(start: 0, end: self.sourceDuration)] : []
    }

    public init(sourceDuration: Double, clips: [EditRange]) {
        self.sourceDuration = max(0, sourceDuration)
        self.clips = Self.normalize(clips, within: self.sourceDuration)
    }

    public var outputDuration: Double { clips.reduce(0) { $0 + $1.duration } }
    public var isUnchanged: Bool { clips == [EditRange(start: 0, end: sourceDuration)] }
    public var keepRanges: [EditRange] { clips }

    /// True when both play exactly the same video, for example before and after a split.
    public func playsSame(as other: EditTimeline) -> Bool {
        Self.joined(clips) == Self.joined(other.clips)
    }

    private static func joined(_ ranges: [EditRange]) -> [EditRange] {
        var result: [EditRange] = []
        for range in ranges {
            if let last = result.last, abs(range.start - last.end) < 1e-9 {
                result[result.count - 1].end = range.end
            } else {
                result.append(range)
            }
        }
        return result
    }

    /// Where each clip starts on the output timeline.
    public var outputStarts: [Double] {
        var starts: [Double] = []
        var total = 0.0
        for clip in clips {
            starts.append(total)
            total += clip.duration
        }
        return starts
    }

    /// The clip playing at an output time and how far into it, clamped to the timeline.
    public func locate(output time: Double) -> (index: Int, offset: Double)? {
        guard !clips.isEmpty else { return nil }
        var remaining = min(max(0, time), outputDuration)
        for (index, clip) in clips.enumerated() {
            if remaining < clip.duration || index == clips.count - 1 {
                return (index, min(remaining, clip.duration))
            }
            remaining -= clip.duration
        }
        return nil
    }

    public func sourceTime(forOutput time: Double) -> Double {
        guard let (index, offset) = locate(output: time) else { return 0 }
        return clips[index].start + offset
    }

    /// The output time showing a source time; source time inside a cut maps to the start of the next clip.
    public func outputTime(forSource time: Double) -> Double {
        var total = 0.0
        for clip in clips {
            if time < clip.start { return total }
            if time <= clip.end { return total + time - clip.start }
            total += clip.duration
        }
        return total
    }

    /// Splits the clip under an output time. Nil when the split would leave a piece too short to keep.
    public func splitting(atOutput time: Double) -> EditTimeline? {
        guard let (index, offset) = locate(output: time) else { return nil }
        let clip = clips[index]
        guard offset >= Self.minimumClip, clip.duration - offset >= Self.minimumClip else { return nil }
        var next = self
        let cut = clip.start + offset
        next.clips.replaceSubrange(index...index, with: [EditRange(start: clip.start, end: cut), EditRange(start: cut, end: clip.end)])
        return next
    }

    /// Removes a clip. Nil when it is the last one: a Cap can't be edited down to nothing.
    public func deleting(clipAt index: Int) -> EditTimeline? {
        guard clips.indices.contains(index), clips.count > 1 else { return nil }
        var next = self
        next.clips.remove(at: index)
        return next
    }

    /// Moves a clip's start, in source time, between the previous clip's end and its own minimum length.
    public func trimming(clipAt index: Int, start: Double) -> EditTimeline {
        guard clips.indices.contains(index) else { return self }
        let floor = index > 0 ? clips[index - 1].end : 0
        var next = self
        next.clips[index].start = min(max(floor, start), clips[index].end - Self.minimumClip)
        return next
    }

    /// Moves a clip's end, in source time, between its own minimum length and the next clip's start.
    public func trimming(clipAt index: Int, end: Double) -> EditTimeline {
        guard clips.indices.contains(index) else { return self }
        let ceiling = index < clips.count - 1 ? clips[index + 1].start : sourceDuration
        var next = self
        next.clips[index].end = max(min(ceiling, end), clips[index].start + Self.minimumClip)
        return next
    }

    /// The source time a clip's start can reach back to: the end of the clip before it, or the video's start.
    public func earliestStart(ofClipAt index: Int) -> Double { index > 0 ? clips[index - 1].end : 0 }
    public func latestEnd(ofClipAt index: Int) -> Double { index < clips.count - 1 ? clips[index + 1].start : sourceDuration }

    static func normalize(_ ranges: [EditRange], within duration: Double) -> [EditRange] {
        let clamped = ranges
            .map { EditRange(start: min(max(0, $0.start), duration), end: min(max(0, $0.end), duration)) }
            .filter { $0.duration >= minimumClip }
            .sorted { $0.start < $1.start }
        var result: [EditRange] = []
        for range in clamped {
            if let last = result.last, range.start < last.end {
                result[result.count - 1].end = max(last.end, range.end)
            } else {
                result.append(range)
            }
        }
        return result
    }
}

private struct CapEditBody: Encodable {
    let sourceDuration: Double
    let keepRanges: [EditRange]
}

extension CapAPI {
    public func editState(_ id: CapID) async throws(CapAPIError) -> CapEditState {
        try await send(APIRequest(method: .get, path: ["api", "mobile", "caps", id.rawValue, "edit"]))
    }

    /// Starts rendering the edit on Cap's servers. The Cap reports processing until the new version is ready.
    public func saveEdit(_ id: CapID, timeline: EditTimeline) async throws(CapAPIError) {
        guard !timeline.clips.isEmpty else { throw CapAPIError.badRequest }
        let body = try Self.body(CapEditBody(sourceDuration: timeline.sourceDuration, keepRanges: timeline.keepRanges))
        let response: SuccessResponse = try await send(APIRequest(method: .post, path: ["api", "mobile", "caps", id.rawValue, "edit"], body: body))
        guard response.success else { throw CapAPIError.invalidResponse }
    }

    public func restoreOriginal(_ id: CapID) async throws(CapAPIError) {
        let response: SuccessResponse = try await send(APIRequest(method: .post, path: ["api", "mobile", "caps", id.rawValue, "edit", "restore"]))
        guard response.success else { throw CapAPIError.invalidResponse }
    }
}
