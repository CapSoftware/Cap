import Foundation
import Testing
@testable import CapKit

private func comment(_ id: String, _ kind: CommentKind = .text, content: String = "hi", at time: Double? = nil, parent: String? = nil, author: String = "a", minute: Int = 0) -> CapComment {
    let date = Date(timeIntervalSince1970: 1_700_000_000 + Double(minute) * 60)
    return CapComment(id: id, videoId: "v", type: kind, content: content, timestamp: time, parentCommentId: parent, createdAt: date, updatedAt: date, author: CommentAuthor(id: author, name: author, imageUrl: nil))
}

@Suite struct SocialTests {
    @Test func threadsAreOneLevelDeepOldestFirst() {
        let threads = CommentThreads.build([
            comment("b", minute: 2),
            comment("a", minute: 1),
            comment("a1", parent: "a", minute: 3),
            comment("a1x", parent: "a1", minute: 4),
            comment("orphan", parent: "gone", minute: 5),
            comment("r", .emoji, content: "👍", minute: 6),
            comment("empty-parent", parent: "", minute: 7),
        ])
        #expect(threads.map(\.id) == ["a", "b", "empty-parent"])
        #expect(threads[0].replies.map(\.id) == ["a1", "a1x"])
    }

    @Test func threadingSurvivesParentCycles() {
        let threads = CommentThreads.build([comment("x", parent: "y"), comment("y", parent: "x")])
        #expect(threads.isEmpty)
    }

    @Test func markersBucketNearbyMomentsAndSkipUntimed() {
        let markers = TimelineMarkers.build([
            comment("c1", at: 10, author: "sam"),
            comment("c2", at: 11, author: "ana"),
            comment("r1", .emoji, content: "😂", at: 12),
            comment("r2", .emoji, content: "😂", at: 90),
            comment("r3", .emoji, content: "👍", at: 91),
            comment("r4", .emoji, content: "😂", at: 92),
            comment("untimed", at: nil),
            comment("reply", at: 50, parent: "c1"),
            comment("late", at: 500),
        ], duration: 100, buckets: 20)
        #expect(markers.count == 3)
        #expect(markers[0].commentIds == ["c1", "c2", "r1"])
        #expect(markers[0].textCount == 2)
        #expect(markers[0].authors.map(\.id) == ["sam", "ana"])
        #expect(markers[0].leadingEmoji == nil)
        #expect(markers[1].leadingEmoji == "😂")
        #expect(markers[2].position == 1)
        #expect(TimelineMarkers.build([comment("c", at: 1)], duration: 0, buckets: 10).isEmpty)
    }

    @Test func activeCueUsesHalfOpenRanges() {
        let cues = [TranscriptCue(id: 0, start: 0, end: 2, text: "a"), TranscriptCue(id: 1, start: 2, end: 4, text: "b"), TranscriptCue(id: 2, start: 6, end: 8, text: "c")]
        #expect(TranscriptCue.active(in: cues, at: 0)?.id == 0)
        #expect(TranscriptCue.active(in: cues, at: 2)?.id == 1)
        #expect(TranscriptCue.active(in: cues, at: 5) == nil)
        #expect(TranscriptCue.active(in: cues, at: 9) == nil)
        #expect(TranscriptCue.active(in: [], at: 1) == nil)
    }

    @Test func transcriptExports() {
        let cues = [TranscriptCue(id: 0, start: 0, end: 2, text: "Hello"), TranscriptCue(id: 1, start: 2.5, end: 4, text: "there."), TranscriptCue(id: 2, start: 70, end: 72.25, text: "Later")]
        #expect(TranscriptExport.plainText(cues) == "Hello there.\n\nLater")
        let run = (0..<13).map { TranscriptCue(id: $0, start: Double($0), end: Double($0) + 0.9, text: "w\($0)") }
        let paragraphs = TranscriptExport.plainText(run).components(separatedBy: "\n\n")
        #expect(paragraphs.map { $0.split(separator: " ").count } == [6, 6, 1])
        #expect(paragraphs.joined(separator: " ") == run.map(\.text).joined(separator: " "))
        #expect(TranscriptExport.timestamped(cues) == "[0:00] Hello\n[0:02] there.\n[1:10] Later")
        #expect(TranscriptExport.vtt(cues).hasPrefix("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello"))
        #expect(TranscriptExport.vtt(cues).contains("00:01:10.000 --> 00:01:12.250"))
        #expect(WebVTT.parse(TranscriptExport.vtt(cues)).map(\.text) == ["Hello", "there.", "Later"])
    }

    @Test func shareTargetsReadTimeAndComment() throws {
        guard case let .share(target)? = DeepLink.parse(URL(string: "https://cap.so/s/abc?t=83.5&comment=c_12")!) else {
            Issue.record("not a share link")
            return
        }
        #expect(target.startTime == 83.5)
        #expect(target.commentId == "c_12")
        guard case let .share(bad)? = DeepLink.parse(URL(string: "https://cap.so/s/abc?t=-1&comment=../x")!) else {
            Issue.record("not a share link")
            return
        }
        #expect(bad.startTime == nil)
        #expect(bad.commentId == nil)
        guard case let .share(huge)? = DeepLink.parse(URL(string: "cap://s/abc?t=1e12&reply=r1")!) else {
            Issue.record("not a share link")
            return
        }
        #expect(huge.startTime == nil)
        #expect(huge.commentId == "r1")
        #expect(CapEnvironment.production.shareURL(for: CapID("abc")!, at: 83.9).absoluteString == "https://cap.so/s/abc?t=83")
        #expect(CapEnvironment.production.shareURL(for: CapID("abc")!, at: 0.4).absoluteString == "https://cap.so/s/abc")
    }

    @Test func viewerDecodesDefensively() throws {
        let decoder = CapJSON.decoder()
        let viewer = try decoder.decode(CapViewer.self, from: Data(#"{"settings":{"disableComments":true,"disableCaptions":"yes"},"defaultPlaybackSpeed":99,"canDownload":true}"#.utf8))
        #expect(viewer.settings.disableComments)
        #expect(!viewer.settings.disableCaptions)
        #expect(viewer.defaultPlaybackSpeed == 2)
        #expect(viewer.canDownload)
        #expect(!viewer.overShareLimit)
        #expect(CapViewer.nearestSpeed(to: .nan) == 1.2)
        #expect(CapViewer.nearestSpeed(to: 1.16) == 1.2)
    }

    @Test func passwordUnlockIsSentOnlyForThatCap() async throws {
        let (api, transport) = makeAPI { request in
            if request.url?.path() == "/api/mobile/caps/abc/unlock" {
                return (200, Data(#"{"accessToken":"sealed-token","expiresAt":"2099-01-01T00:00:00.000Z"}"#.utf8))
            }
            return (200, Data(#"{"status":"granted"}"#.utf8))
        }
        let abc = CapID("abc")!
        let other = CapID("other")!
        try await api.unlockCap(abc, password: "hunter2")
        _ = try await api.capAccess(abc)
        _ = try await api.capAccess(other)
        let requests = transport.requests
        #expect(requests[0].value(forHTTPHeaderField: "X-Cap-Video-Access") == nil)
        #expect(try bodyJSON(requests[0])["password"] as? String == "hunter2")
        #expect(requests[1].value(forHTTPHeaderField: "X-Cap-Video-Access") == "sealed-token")
        #expect(requests[2].value(forHTTPHeaderField: "X-Cap-Video-Access") == nil)
        api.clearVideoAccess()
        #expect(!api.hasVideoAccess(for: abc))
    }

    @Test func unlockTravelsOnlyWithThatCapsThumbnail() async throws {
        let (api, _) = makeAPI { _ in (200, Data(#"{"accessToken":"sealed","expiresAt":"2099-01-01T00:00:00.000Z"}"#.utf8)) }
        try await api.unlockCap(CapID("abc")!, password: "pw")
        #expect(api.mediaHeaders(for: URL(string: "https://cap.so/api/mobile/caps/abc/thumbnail?v=1")!)["X-Cap-Video-Access"] == "sealed")
        #expect(api.mediaHeaders(for: URL(string: "https://cap.so/api/mobile/caps/other/thumbnail")!)["X-Cap-Video-Access"] == nil)
        #expect(api.mediaHeaders(for: URL(string: "https://cap.so/api/mobile/caps/abc")!)["X-Cap-Video-Access"] == nil)
        #expect(api.mediaHeaders(for: URL(string: "https://s3.amazonaws.com/api/mobile/caps/abc/thumbnail")!).isEmpty)
        #expect(api.mediaHeaders(for: URL(string: "https://cap.so/api/mobile/caps/abc/thumbnail")!)["Authorization"] != nil)
    }

    @Test func expiredUnlocksAreDropped() async throws {
        let (api, _) = makeAPI { _ in (200, Data(#"{"accessToken":"t","expiresAt":"2001-01-01T00:00:00.000Z"}"#.utf8)) }
        try await api.unlockCap(CapID("abc")!, password: "pw")
        #expect(!api.hasVideoAccess(for: CapID("abc")!))
    }

    @Test func accessStatusFallsBackToUnknown() async throws {
        let (api, _) = makeAPI { _ in (200, Data(#"{"status":"sign_in_required"}"#.utf8)) }
        #expect(try await api.capAccess(CapID("abc")!) == .unknown)
    }
}
