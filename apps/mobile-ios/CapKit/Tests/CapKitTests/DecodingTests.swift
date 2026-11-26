import Foundation
import Testing
@testable import CapKit

func fixture(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
}

@Suite struct DecodingTests {
    @Test func bootstrapSkipsMalformedOrganizationsAndDefaultsUnknownRoles() throws {
        let bootstrap = try CapJSON.decoder().decode(Bootstrap.self, from: fixture("bootstrap"))
        #expect(bootstrap.user.displayName == "Richie McIlroy")
        #expect(bootstrap.organizations.map(\.id) == ["org_123", "org_456"])
        #expect(bootstrap.organizations[1].role == .member)
        #expect(bootstrap.activeOrganization?.name == "Cap")
        #expect(bootstrap.spaces.count == 2)
        #expect(bootstrap.spaces[1].privacy == .isPublic)
        #expect(bootstrap.spaces[1].hasPassword)
        #expect(bootstrap.rootFolders.first?.color == .blue)
    }

    @Test func capsPageDropsBrokenCapsInsteadOfFailing() throws {
        let page = try CapJSON.decoder().decode(CapsPage.self, from: fixture("caps"))
        #expect(page.caps.map(\.id) == ["cap_1", "cap_2"])
        #expect(page.folders.first?.color == .normal)
        #expect(page.collectionTotal == 12)
        let first = page.caps[0]
        #expect(first.isPublic)
        #expect(first.viewCount == 1200)
        #expect(first.durationSeconds == 125.4)
        #expect(first.isOwned(by: "someone-else"))
        let second = page.caps[1]
        #expect(second.isProtected)
        #expect(second.ownedByCurrentUser == nil)
        #expect(second.isOwned(by: "user_123") == false)
        #expect(second.upload?.fractionCompleted == 0.25)
        #expect(second.isProcessing)
    }

    @Test func capLinkAccessIsOptionalAndToleratesUnknownValues() throws {
        func cap(_ extra: String) throws -> CapSummary {
            let json = #"{"id":"cap_1","shareUrl":"https://cap.so/s/cap_1","title":"Demo","createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-01T00:00:00.000Z","ownerName":"Owner","durationSeconds":null,"thumbnailUrl":null,"folderId":null,"public":true,"protected":false,"viewCount":0,"commentCount":0,"reactionCount":0,"upload":null"# + extra + "}"
            return try CapJSON.decoder().decode(CapSummary.self, from: Data(json.utf8))
        }
        #expect(try cap("").linkAccess == nil)
        #expect(try cap(#","linkAccess":"restricted""#).linkAccess == .restricted)
        #expect(try cap(#","linkAccess":"anyone""#).linkAccess == .anyone)
        #expect(try cap(#","linkAccess":"something-new""#).linkAccess == nil)
        #expect(try cap(#","linkAccess":null"#).linkAccess == nil)
        #expect(try cap("").linkRestricted == nil)
        #expect(try cap(#","linkRestricted":true"#).linkRestricted == true)
        #expect(try cap(#","linkRestricted":false,"linkAccess":"anyone""#).linkRestricted == false)
        #expect(try cap(#","linkRestricted":"yes""#).linkRestricted == nil)
        let page = try CapJSON.decoder().decode(CapsPage.self, from: fixture("caps"))
        #expect(page.caps.allSatisfy { $0.linkAccess == nil })
    }

    @Test func capDetailDecodesChaptersAndComments() throws {
        let detail = try CapJSON.decoder().decode(CapDetail.self, from: fixture("cap-detail"))
        #expect(detail.chapters.count == 2)
        #expect(detail.transcriptionStatus == .complete)
        #expect(detail.comments.map(\.type) == [.text, .emoji])
        #expect(detail.comments[0].timestamp == 12.5)
        #expect(detail.cap.isOwned(by: "user_123") == false)
    }

    @Test func analyticsParsesBucketsAndTopCapIds() throws {
        let response = try CapJSON.decoder().decode(AnalyticsResponse.self, from: fixture("analytics"))
        let data = try #require(response.data)
        #expect(data.counts.views == 1200)
        #expect(data.chart.compactMap(\.date).count == 2)
        #expect(data.breakdowns.topCaps.first?.capId == "cap_1")
        #expect(data.breakdowns.cities.first?.subtitle == "GB")
    }

    @Test func organizationSettingsDecode() throws {
        let settings = try CapJSON.decoder().decode(OrganizationSettings.self, from: fixture("org-settings"))
        #expect(settings.role == .admin)
        #expect(settings.customDomain == "videos.cap.so")
    }

    @Test func snapshotsRoundTripThroughEncoder() throws {
        let page = try CapJSON.decoder().decode(CapsPage.self, from: fixture("caps"))
        let encoded = try CapJSON.encoder().encode(page)
        let decoded = try CapJSON.decoder().decode(CapsPage.self, from: encoded)
        #expect(decoded == page)
        let analytics = try CapJSON.decoder().decode(AnalyticsResponse.self, from: fixture("analytics"))
        let analyticsRoundTrip = try CapJSON.decoder().decode(AnalyticsResponse.self, from: CapJSON.encoder().encode(analytics))
        #expect(analyticsRoundTrip == analytics)
    }

    @Test func uploadTargetsDecodeAllVariantsAndRejectUnknown() throws {
        let decoder = CapJSON.decoder()
        let post = try decoder.decode(UploadTarget.self, from: Data(#"{"type":"s3Post","url":"https://s3.example.com","fields":{"key":"a"}}"#.utf8))
        #expect(post == .s3Post(url: "https://s3.example.com", fields: ["key": "a"]))
        let put = try decoder.decode(UploadTarget.self, from: Data(#"{"type":"put","url":"https://r2.example.com/x","headers":{"Content-Type":"video/mp4"}}"#.utf8))
        #expect(put.url == "https://r2.example.com/x")
        #expect(throws: DecodingError.self) {
            try decoder.decode(UploadTarget.self, from: Data(#"{"type":"ftp","url":"ftp://x"}"#.utf8))
        }
    }
}
