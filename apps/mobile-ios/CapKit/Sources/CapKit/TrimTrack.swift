import Foundation

public enum TrimEdge: Sendable, Hashable {
    case start
    case end
}

public enum TrimTouch: Sendable, Hashable {
    case scrub
    case handle(TrimEdge)
}

/// The trim strip's geometry and touch rules. Every constant was measured from the system Photos video trimmer on
/// iOS 27 so the editor's handles behave the same way. Positions are points along the strip, 0 at the video's start.
public struct TrimTrack: Sendable, Hashable {
    public static let handleWidth: Double = 18
    /// How far inside the kept range a moving touch still takes the handle.
    public static let grabReach: Double = 50
    /// A held handle sits with its inner edge this far from the finger, on the handle's side.
    public static let fingerInset: Double = 3.6
    public static let playheadWidth: Double = 4
    public static let zoomFactor: Double = 5
    public static let dragThreshold: Double = 10
    public static let holdDelay: Double = 0.53

    public struct Zoom: Sendable, Hashable {
        public let time: Double
        public let position: Double

        public init(time: Double, position: Double) {
            self.time = time
            self.position = position
        }
    }

    public let duration: Double
    public let width: Double
    public var zoom: Zoom?

    public init(duration: Double, width: Double, zoom: Zoom? = nil) {
        self.duration = max(0, duration)
        self.width = max(0, width)
        self.zoom = zoom
    }

    public var pointsPerSecond: Double {
        guard duration > 0 else { return 0 }
        return width / duration * (zoom == nil ? 1 : Self.zoomFactor)
    }

    public func position(for time: Double) -> Double {
        guard let zoom else { return time * pointsPerSecond }
        return zoom.position + (time - zoom.time) * pointsPerSecond
    }

    public func time(for position: Double) -> Double {
        let scale = pointsPerSecond
        guard scale > 0 else { return 0 }
        guard let zoom else { return position / scale }
        return zoom.time + (position - zoom.position) / scale
    }

    public func edge(_ edge: TrimEdge, forFingerAt position: Double) -> Double {
        edge == .start ? position + Self.fingerInset : position - Self.fingerInset
    }

    /// What a touch that went down at `origin` and has just started moving at `position` takes hold of. A handle
    /// takes it from anywhere on its own side and up to `grabReach` inside the clip, unless the playhead is at least
    /// as close.
    ///
    /// Photos applies the playhead rule to touches on the handle too, so with the playhead resting against a handle
    /// only its outer few points trim and the rest scrubs. Here a touch that goes down on a handle always takes it.
    public func touch(
        from origin: Double,
        at position: Double,
        clip: EditRange,
        earliestStart: Double,
        latestEnd: Double,
        playhead: Double?
    ) -> TrimTouch {
        let start = self.position(for: clip.start)
        let end = self.position(for: clip.end)
        // A handle owns the cut video on its own side and its own drawn width, and nothing of a neighbouring kept
        // clip beyond that. Only the ends of the video have a spare handle slot outside them.
        let leading = earliestStart <= 0 ? Self.handleWidth : 0
        let trailing = latestEnd >= duration ? Self.handleWidth : 0
        let startFloor = min(self.position(for: earliestStart) - leading, start - Self.handleWidth)
        let endCeiling = max(self.position(for: latestEnd) + trailing, end + Self.handleWidth)
        if origin >= startFloor, origin <= start { return .handle(.start) }
        if origin <= endCeiling, origin >= end { return .handle(.end) }
        var best: (edge: TrimEdge, distance: Double)?
        if position >= startFloor, position <= start + Self.grabReach {
            best = (.start, abs(position - (start - Self.fingerInset)))
        }
        if position <= endCeiling, position >= end - Self.grabReach {
            let distance = abs(position - (end + Self.fingerInset))
            if best.map({ distance < $0.distance }) ?? true { best = (.end, distance) }
        }
        guard let best else { return .scrub }
        if let playhead, max(0, abs(position - playhead) - Self.playheadWidth / 2) <= best.distance { return .scrub }
        return .handle(best.edge)
    }

    public func playheadPosition(for time: Double, in clip: EditRange) -> Double {
        let half = Self.playheadWidth / 2
        let low = position(for: clip.start) + half
        let high = position(for: clip.end) - half
        return low <= high ? min(max(position(for: time), low), high) : (low + high) / 2
    }
}
