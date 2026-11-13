import Foundation
import Testing
@testable import CapKit

/// Each case is a touch made on the Photos trimmer with a 40 second clip on a 288 point strip, and what Photos did.
/// A touch travels 10 points before it counts, so each one is where it went down and where it was by then.
@Suite struct TrimTrackTests {
    private let track = TrimTrack(duration: 40, width: 288)
    private let whole = EditRange(start: 0, end: 40)

    private func touch(from origin: Double, at position: Double, clip: EditRange? = nil, playhead: Double, on track: TrimTrack? = nil) -> TrimTouch {
        let track = track ?? self.track
        return track.touch(from: origin, at: position, clip: clip ?? whole, earliestStart: 0, latestEnd: track.duration, playhead: playhead)
    }

    @Test func mapsTimeAndPosition() {
        #expect(abs(track.pointsPerSecond - 7.2) < 1e-9)
        #expect(abs(track.position(for: 12.5) - 90) < 1e-9)
        #expect(abs(track.time(for: 90) - 12.5) < 1e-9)
        #expect(TrimTrack(duration: 0, width: 288).time(for: 40) == 0)
    }

    @Test func aHandleTakesTouchesWithinItsReach() {
        #expect(touch(from: 248, at: 238, playhead: 19) == .handle(.end))
        #expect(touch(from: 244, at: 234, playhead: 19) == .scrub)
        #expect(touch(from: 228, at: 238, playhead: 19) == .handle(.end))
        #expect(touch(from: 224, at: 234, playhead: 19) == .scrub)
        #expect(touch(from: 40, at: 50, playhead: 219) == .handle(.start))
        #expect(touch(from: 60, at: 70, playhead: 219) == .scrub)
        #expect(touch(from: 302, at: 292, playhead: 19) == .handle(.end))
        #expect(touch(from: -15, at: -5, playhead: 219) == .handle(.start))
    }

    @Test func thePlayheadWinsWhenItIsCloser() {
        #expect(touch(from: 268, at: 258, playhead: 224) == .scrub)
        #expect(touch(from: 268, at: 258, playhead: 218) == .handle(.end))
        #expect(touch(from: 270, at: 260, playhead: 252) == .scrub)
        #expect(touch(from: 282, at: 272, playhead: 276) == .scrub)
    }

    @Test func aTrimmedClipKeepsTheSameRules() {
        let trimmed = EditRange(start: 12.861, end: 27.139)
        #expect(touch(from: 139, at: 149, clip: trimmed, playhead: 94.6) == .handle(.end))
        #expect(touch(from: 245.1, at: 235.1, clip: EditRange(start: 0, end: 28.759), playhead: 205.07) == .handle(.end))
        #expect(touch(from: 136.6, at: 126.6, clip: EditRange(start: 18.694, end: 21.583), playhead: 136.6) == .handle(.start))
    }

    /// The one place this departs from Photos, which scrubs for the first four.
    @Test func aTouchThatGoesDownOnAHandleAlwaysTakesIt() {
        #expect(touch(from: 297, at: 287, playhead: 286) == .handle(.end))
        #expect(touch(from: 199, at: 189, clip: EditRange(start: 0, end: 27.139), playhead: 193.4) == .handle(.end))
        #expect(touch(from: -9, at: 1, playhead: 2) == .handle(.start))
        let long = TrimTrack(duration: 300, width: 288)
        #expect(touch(from: 174.4, at: 164.4, clip: EditRange(start: 164.167, end: 172.292), playhead: 159.6, on: long) == .handle(.end))
        #expect(touch(from: 8, at: 18, playhead: 2) == .scrub)
    }

    @Test func aNeighbouringClipKeepsItsOwnTouches() {
        let clip = EditRange(start: 20, end: 30)
        let boxedIn = track.touch(from: 90, at: 100, clip: clip, earliestStart: 20, latestEnd: 30, playhead: 180)
        #expect(boxedIn == .scrub)
        let handle = track.touch(from: 120, at: 130, clip: clip, earliestStart: 20, latestEnd: 30, playhead: 180)
        #expect(handle == .handle(.start))
        let freed = track.touch(from: 90, at: 100, clip: clip, earliestStart: 10, latestEnd: 30, playhead: 180)
        #expect(freed == .handle(.start))
        let insideEarlierClip = track.touch(from: 57.6, at: 67.6, clip: clip, earliestStart: 10, latestEnd: 30, playhead: 180)
        #expect(insideEarlierClip == .scrub)
        let insideLaterClip = track.touch(from: 262, at: 252, clip: clip, earliestStart: 10, latestEnd: 34, playhead: 180)
        #expect(insideLaterClip == .scrub)
        let cutAfter = track.touch(from: 240, at: 230, clip: clip, earliestStart: 10, latestEnd: 34, playhead: 180)
        #expect(cutAfter == .handle(.end))
    }

    @Test func aHeldHandleSitsUnderTheFinger() {
        #expect(abs(track.time(for: track.edge(.end, forFingerAt: 199)) - 27.139) < 0.001)
        #expect(abs(track.time(for: track.edge(.start, forFingerAt: 89)) - 12.861) < 0.001)
    }

    @Test func holdingExpandsTheStripAroundTheHandle() {
        var long = TrimTrack(duration: 300, width: 288)
        let start = long.position(for: 146.111)
        long.zoom = TrimTrack.Zoom(time: 146.111, position: start)
        #expect(abs(long.position(for: 146.111) - start) < 1e-9)
        #expect(abs(long.position(for: 172.292) - start - 125.7) < 0.1)
        #expect(abs(long.time(for: start + 4.8) - 147.111) < 1e-6)
    }

    @Test func thePlayheadStaysClearOfTheHandles() {
        let clip = EditRange(start: 12.861, end: 27.139)
        #expect(abs(track.playheadPosition(for: 12.861, in: clip) - (track.position(for: 12.861) + 2)) < 1e-9)
        #expect(abs(track.playheadPosition(for: 27.139, in: clip) - (track.position(for: 27.139) - 2)) < 1e-9)
        #expect(abs(track.playheadPosition(for: 20, in: clip) - 144) < 1e-9)
    }
}
