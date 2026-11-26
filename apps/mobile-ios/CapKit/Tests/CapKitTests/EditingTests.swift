import Foundation
import Testing
@testable import CapKit

@Suite struct EditTimelineTests {
    @Test func startsAsTheWholeVideo() {
        let timeline = EditTimeline(sourceDuration: 60)
        #expect(timeline.clips == [EditRange(start: 0, end: 60)])
        #expect(timeline.isUnchanged)
        #expect(timeline.outputDuration == 60)
    }

    @Test func splitsAtThePlayheadAndRefusesSlivers() throws {
        let timeline = EditTimeline(sourceDuration: 60)
        let split = try #require(timeline.splitting(atOutput: 20))
        #expect(split.clips == [EditRange(start: 0, end: 20), EditRange(start: 20, end: 60)])
        #expect(split.outputDuration == 60)
        #expect(timeline.splitting(atOutput: 0.05) == nil)
        #expect(timeline.splitting(atOutput: 59.95) == nil)
        #expect(split.splitting(atOutput: 20.05) == nil)
    }

    @Test func deletesAClipButNeverTheLastOne() throws {
        let split = try #require(EditTimeline(sourceDuration: 60).splitting(atOutput: 20))
        let deleted = try #require(split.deleting(clipAt: 0))
        #expect(deleted.clips == [EditRange(start: 20, end: 60)])
        #expect(deleted.outputDuration == 40)
        #expect(!deleted.isUnchanged)
        #expect(deleted.deleting(clipAt: 0) == nil)
        #expect(split.deleting(clipAt: 5) == nil)
    }

    @Test func mapsOutputAndSourceTimeAcrossCuts() throws {
        // Keep 0-10 and 30-60: 20 seconds are cut.
        let timeline = try #require(EditTimeline(sourceDuration: 60).splitting(atOutput: 10)?.splitting(atOutput: 30)?.deleting(clipAt: 1))
        #expect(timeline.clips == [EditRange(start: 0, end: 10), EditRange(start: 30, end: 60)])
        #expect(timeline.outputDuration == 40)
        #expect(timeline.sourceTime(forOutput: 5) == 5)
        #expect(timeline.sourceTime(forOutput: 15) == 35)
        #expect(timeline.sourceTime(forOutput: 100) == 60)
        #expect(timeline.outputTime(forSource: 35) == 15)
        #expect(timeline.outputTime(forSource: 20) == 10)
        #expect(timeline.outputStarts == [0, 10])
        #expect(timeline.clipIndex(containingSource: 35) == 1)
        #expect(timeline.clipIndex(containingSource: 20) == nil)
        #expect(timeline.removedRanges == [EditRange(start: 10, end: 30)])
        #expect(EditTimeline(sourceDuration: 60).removedRanges.isEmpty)
        #expect(timeline.trimming(clipAt: 1, end: 50).removedRanges == [EditRange(start: 10, end: 30), EditRange(start: 50, end: 60)])
    }

    @Test func trimsStayInsideTheirNeighboursAndKeepAMinimumLength() throws {
        let timeline = try #require(EditTimeline(sourceDuration: 60).splitting(atOutput: 10)?.splitting(atOutput: 30)?.deleting(clipAt: 1))
        // The second clip's start can reach back to the end of the first, not past it.
        #expect(timeline.trimming(clipAt: 1, start: 2).clips[1].start == 10)
        #expect(timeline.trimming(clipAt: 1, start: 25).clips[1].start == 25)
        // The first clip's end can grow into the cut but not past the next clip.
        #expect(timeline.trimming(clipAt: 0, end: 50).clips[0].end == 30)
        // A clip can't be trimmed below the minimum.
        let squeezed = timeline.trimming(clipAt: 0, end: 0)
        #expect(abs(squeezed.clips[0].duration - EditTimeline.minimumClip) < 1e-9)
        #expect(timeline.trimming(clipAt: 1, end: 999).clips[1].end == 60)
        #expect(timeline.earliestStart(ofClipAt: 1) == 10)
        #expect(timeline.latestEnd(ofClipAt: 0) == 30)
    }

    @Test func knowsWhenAnEditPlaysTheSame() throws {
        let whole = EditTimeline(sourceDuration: 60)
        let split = try #require(whole.splitting(atOutput: 20)?.splitting(atOutput: 40))
        #expect(split.playsSame(as: whole))
        let deleted = try #require(split.deleting(clipAt: 1))
        #expect(!deleted.playsSame(as: whole))
        #expect(!split.trimming(clipAt: 0, end: 19).playsSame(as: whole))
    }

    @Test func normalizesRangesFromAnywhere() {
        let timeline = EditTimeline(sourceDuration: 30, clips: [
            EditRange(start: 20, end: 40),
            EditRange(start: -5, end: 5),
            EditRange(start: 4, end: 8),
            EditRange(start: 10, end: 10.05),
        ])
        #expect(timeline.clips == [EditRange(start: 0, end: 8), EditRange(start: 20, end: 30)])
    }

    @Test func encodesTheBodyTheServerExpects() throws {
        let timeline = try #require(EditTimeline(sourceDuration: 12.5).splitting(atOutput: 2.5)?.deleting(clipAt: 0))
        struct Body: Encodable { let sourceDuration: Double; let keepRanges: [EditRange] }
        let data = try JSONEncoder().encode(Body(sourceDuration: timeline.sourceDuration, keepRanges: timeline.keepRanges))
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["sourceDuration"] as? Double == 12.5)
        let ranges = try #require(json["keepRanges"] as? [[String: Double]])
        #expect(ranges == [["start": 2.5, "end": 12.5]])
    }

    @Test func decodesEditStateAndUnknownStatuses() throws {
        let decoder = JSONDecoder()
        let state = try decoder.decode(CapEditState.self, from: Data(#"{"status":"pro_required","duration":61.2,"hasEdits":true}"#.utf8))
        #expect(state.status == .proRequired)
        #expect(state.duration == 61.2)
        #expect(state.hasEdits)
        let unknown = try decoder.decode(CapEditState.self, from: Data(#"{"status":"later","duration":1,"hasEdits":false}"#.utf8))
        #expect(unknown.status == .notEditable)
    }
}
