import Foundation

/// The share page's reaction set, in its order.
public enum Reactions {
    public static let emojis = ["😂", "😍", "😮", "🙌", "👍", "👎"]
}

public struct CommentThread: Identifiable, Sendable, Hashable {
    public let root: CapComment
    public let replies: [CapComment]

    public var id: String { root.id }
}

public enum CommentThreads {
    /// Groups text comments one level deep, oldest first, like the share page.
    /// Replies to replies join their top-level thread; replies whose thread is gone are hidden.
    public static func build(_ comments: [CapComment]) -> [CommentThread] {
        let text = comments.filter { $0.type == .text }
        let byId = Dictionary(text.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        func rootId(of comment: CapComment) -> String? {
            var current = comment
            for _ in 0..<16 {
                guard let parent = current.parentCommentId, !parent.isEmpty else { return current.id }
                guard let next = byId[parent] else { return nil }
                current = next
            }
            return nil
        }

        var replies: [String: [CapComment]] = [:]
        var roots: [CapComment] = []
        for comment in text {
            guard let root = rootId(of: comment) else { continue }
            if root == comment.id {
                roots.append(comment)
            } else {
                replies[root, default: []].append(comment)
            }
        }
        let ordered: (CapComment, CapComment) -> Bool = { $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt }
        return roots.sorted(by: ordered).map { root in
            CommentThread(root: root, replies: (replies[root.id] ?? []).sorted(by: ordered))
        }
    }
}

public struct TimelineMarker: Identifiable, Sendable, Hashable {
    public let id: String
    public let time: Double
    /// 0...1 along the video.
    public let position: Double
    public let commentIds: [String]
    public let authors: [CommentAuthor]
    public let emojis: [String]
    public let textCount: Int
    public let reactionCount: Int

    public var count: Int { textCount + reactionCount }

    /// The most used emoji in the marker, shown when it holds only reactions.
    public var leadingEmoji: String? {
        guard textCount == 0 else { return nil }
        var counts: [String: Int] = [:]
        for emoji in emojis { counts[emoji, default: 0] += 1 }
        return counts.max { $0.value == $1.value ? $0.key > $1.key : $0.value < $1.value }?.key
    }
}

public enum TimelineMarkers {
    /// Buckets timestamped comments and reactions so nearby ones share one marker.
    public static func build(_ comments: [CapComment], duration: Double, buckets: Int) -> [TimelineMarker] {
        guard duration.isFinite, duration > 0, buckets > 0 else { return [] }
        let threads = Set(CommentThreads.build(comments).map(\.id))
        var groups: [Int: [CapComment]] = [:]
        for comment in comments {
            guard let time = comment.timestamp, time.isFinite, time >= 0 else { continue }
            if comment.type == .text, !threads.contains(comment.id) { continue }
            let clamped = min(time, duration)
            let index = min(buckets - 1, Int(clamped / duration * Double(buckets)))
            groups[index, default: []].append(comment)
        }
        return groups.keys.sorted().compactMap { index in
            guard let items = groups[index]?.sorted(by: { ($0.timestamp ?? 0) < ($1.timestamp ?? 0) }), let first = items.first else { return nil }
            let time = min(first.timestamp ?? 0, duration)
            let text = items.filter { $0.type == .text }
            var seen = Set<String>()
            let authors = text.compactMap { comment -> CommentAuthor? in
                seen.insert(comment.author.id).inserted ? comment.author : nil
            }
            return TimelineMarker(
                id: first.id,
                time: time,
                position: time / duration,
                commentIds: items.map(\.id),
                authors: Array(authors.prefix(3)),
                emojis: items.filter { $0.type == .emoji }.map(\.content),
                textCount: text.count,
                reactionCount: items.count - text.count
            )
        }
    }
}

extension TranscriptCue {
    /// The cue playing at `time`, found by binary search over cues sorted by start.
    public static func active(in cues: [TranscriptCue], at time: Double) -> TranscriptCue? {
        var low = 0
        var high = cues.count - 1
        var match: Int?
        while low <= high {
            let mid = (low + high) / 2
            if cues[mid].start <= time {
                match = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        guard let match, time < cues[match].end else { return nil }
        return cues[match]
    }
}

public enum TranscriptExport {
    /// Paragraphs broken at pauses, like the share page's "Formatted text" copy.
    public static func plainText(_ cues: [TranscriptCue]) -> String {
        var paragraphs: [[String]] = []
        var previousEnd: Double?
        for cue in cues {
            let text = cue.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            if let previousEnd, cue.start - previousEnd < 2, var last = paragraphs.popLast(), last.count < 6 {
                last.append(text)
                paragraphs.append(last)
            } else {
                paragraphs.append([text])
            }
            previousEnd = cue.end
        }
        return paragraphs.map { $0.joined(separator: " ") }.joined(separator: "\n\n")
    }

    public static func timestamped(_ cues: [TranscriptCue]) -> String {
        cues.map { "[\(CapFormat.timestamp($0.start))] \($0.text)" }.joined(separator: "\n")
    }

    public static func vtt(_ cues: [TranscriptCue]) -> String {
        func stamp(_ seconds: Double) -> String {
            let millis = Int((max(0, seconds) * 1000).rounded())
            return String(format: "%02d:%02d:%02d.%03d", millis / 3_600_000, (millis / 60_000) % 60, (millis / 1000) % 60, millis % 1000)
        }
        let body = cues.map { "\(stamp($0.start)) --> \(stamp($0.end))\n\($0.text)" }.joined(separator: "\n\n")
        return "WEBVTT\n\n" + body + "\n"
    }
}
