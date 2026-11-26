import Foundation

public struct EditRange: Codable, Sendable, Hashable {
    public var start: Double
    public var end: Double

    public init(start: Double, end: Double) {
        self.start = start
        self.end = end
    }

    public var duration: Double { end - start }
}

public struct CapEditState: Codable, Sendable, Hashable {
    public enum Status: String, UnknownCaseDecodable {
        case available
        case proRequired = "pro_required"
        case notEditable = "not_editable"
        case busy

        public static let unknownCase = Status.notEditable
    }

    public let status: Status
    /// Edits are made against this, the video as it is now.
    public let duration: Double
    public let hasEdits: Bool

    public init(status: Status, duration: Double, hasEdits: Bool) {
        self.status = status
        self.duration = duration
        self.hasEdits = hasEdits
    }
}

/// "Output" time is the edited video's own timeline; "source" time is the video as it is now.
public struct EditTimeline: Sendable, Hashable {
    /// Matches the floor the web editor and media server use.
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

    public var outputStarts: [Double] {
        var starts: [Double] = []
        var total = 0.0
        for clip in clips {
            starts.append(total)
            total += clip.duration
        }
        return starts
    }

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

    public func outputTime(forSource time: Double) -> Double {
        var total = 0.0
        for clip in clips {
            if time < clip.start { return total }
            if time <= clip.end { return total + time - clip.start }
            total += clip.duration
        }
        return total
    }

    public func clipIndex(containingSource time: Double) -> Int? {
        clips.firstIndex { time >= $0.start && time <= $0.end }
    }

    public var removedRanges: [EditRange] {
        var removed: [EditRange] = []
        var cursor = 0.0
        for clip in clips {
            if clip.start - cursor > 1e-6 { removed.append(EditRange(start: cursor, end: clip.start)) }
            cursor = clip.end
        }
        if sourceDuration - cursor > 1e-6 { removed.append(EditRange(start: cursor, end: sourceDuration)) }
        return removed
    }

    public func splitting(atOutput time: Double) -> EditTimeline? {
        guard let (index, offset) = locate(output: time) else { return nil }
        let clip = clips[index]
        guard offset >= Self.minimumClip, clip.duration - offset >= Self.minimumClip else { return nil }
        var next = self
        let cut = clip.start + offset
        next.clips.replaceSubrange(index...index, with: [EditRange(start: clip.start, end: cut), EditRange(start: cut, end: clip.end)])
        return next
    }

    public func deleting(clipAt index: Int) -> EditTimeline? {
        guard clips.indices.contains(index), clips.count > 1 else { return nil }
        var next = self
        next.clips.remove(at: index)
        return next
    }

    public func trimming(clipAt index: Int, start: Double) -> EditTimeline {
        guard clips.indices.contains(index) else { return self }
        let floor = index > 0 ? clips[index - 1].end : 0
        var next = self
        next.clips[index].start = min(max(floor, start), clips[index].end - Self.minimumClip)
        return next
    }

    public func trimming(clipAt index: Int, end: Double) -> EditTimeline {
        guard clips.indices.contains(index) else { return self }
        let ceiling = index < clips.count - 1 ? clips[index + 1].start : sourceDuration
        var next = self
        next.clips[index].end = max(min(ceiling, end), clips[index].start + Self.minimumClip)
        return next
    }

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
