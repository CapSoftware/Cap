import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import CapKit

@Suite struct FormattingTests {
    @Test func formatsTimestamps() {
        #expect(CapFormat.timestamp(0) == "0:00")
        #expect(CapFormat.timestamp(65.9) == "1:05")
        #expect(CapFormat.timestamp(3723) == "1:02:03")
        #expect(CapFormat.timestamp(-.infinity) == "0:00")
        #expect(CapFormat.duration(nil) == nil)
        #expect(CapFormat.duration(.nan) == nil)
    }

    @Test func buildsFlags() {
        #expect(CapFormat.flag(forRegionCode: "gb") == "🇬🇧")
        #expect(CapFormat.flag(forRegionCode: "USA") == nil)
        #expect(CapFormat.flag(forRegionCode: "1A") == nil)
    }

    @Test func formatsPercentages() {
        #expect(CapFormat.percentage(50) == CapFormat.percentage(0.5))
    }
}

@Suite struct WebVTTTests {
    @Test func parsesCuesAndStripsMarkup() {
        let source = "WEBVTT\r\n\r\n1\r\n00:00:01.000 --> 00:00:04.500 align:start\r\n<v Richie>Hello there</v>\r\n\r\n00:01:02,250 --> 00:01:05.000\nSecond line\ncontinues\n\nbroken --> cue\nIgnored\n"
        let cues = WebVTT.parse(source)
        #expect(cues.count == 2)
        #expect(cues[0].start == 1)
        #expect(cues[0].end == 4.5)
        #expect(cues[0].text == "Hello there")
        #expect(cues[1].start == 62.25)
        #expect(cues[1].text == "Second line continues")
    }
}

@Suite struct ImageCodingTests {
    func makeImage(width: Int, height: Int) throws -> CGImage {
        let context = try #require(CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        for index in 0..<64 {
            context.setFillColor(CGColor(red: CGFloat(index % 4) / 3, green: CGFloat(index % 7) / 6, blue: CGFloat(index % 5) / 4, alpha: 1))
            context.fill(CGRect(x: index * 37 % width, y: index * 53 % height, width: width / 3, height: height / 5))
        }
        return try #require(context.makeImage())
    }

    @Test func encodesUploadsAsSmallJPEGsWithoutMetadata() throws {
        let image = try makeImage(width: 4000, height: 3000)
        let output = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(output, "public.png" as CFString, 1, nil))
        let gps = [kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 51.5, kCGImagePropertyGPSLongitude: -0.12]] as CFDictionary
        CGImageDestinationAddImage(destination, image, gps)
        #expect(CGImageDestinationFinalize(destination))

        let encoded = try ImageCoding.encodeForUpload(output as Data)
        #expect(encoded.contentType == "image/jpeg")
        #expect(encoded.data.count <= ImageCoding.uploadByteLimit)
        #expect(Array(encoded.data.prefix(3)) == [0xFF, 0xD8, 0xFF])

        let source = try #require(CGImageSourceCreateWithData(encoded.data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        #expect(properties[kCGImagePropertyGPSDictionary] == nil)
        let width = try #require(properties[kCGImagePropertyPixelWidth] as? Int)
        #expect(width <= 1024)
    }

    @Test func rejectsNonImages() {
        #expect(throws: ImageCodingError.unreadable) {
            try ImageCoding.encodeForUpload(Data("not an image".utf8))
        }
    }
}

@Suite struct UploadTests {
    @Test func writesMultipartBodyWithFieldsBeforeFile() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appending(path: "clip.mp4")
        try Data("VIDEO".utf8).write(to: file)
        let body = directory.appending(path: "body")
        try MultipartBody.write(fields: ["key": "u/v/raw.mp4", "Policy": "abc"], fileURL: file, fileName: "clip\"\r\n.mp4", contentType: "video/mp4", boundary: "B", to: body)
        let text = try String(contentsOf: body, encoding: .utf8)
        #expect(text == "--B\r\nContent-Disposition: form-data; name=\"Policy\"\r\n\r\nabc\r\n--B\r\nContent-Disposition: form-data; name=\"key\"\r\n\r\nu/v/raw.mp4\r\n--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"clip.mp4\"\r\nContent-Type: video/mp4\r\n\r\nVIDEO\r\n--B--\r\n")
    }

    @Test func rejectsInsecureUploadTargets() {
        let engine = UploadEngine(environment: .production)
        #expect(throws: UploadError.insecureTarget) { try engine.validatedURL("http://s3.amazonaws.com/x") }
        #expect(throws: UploadError.insecureTarget) { try engine.validatedURL("http://localhost:3902/x") }
        #expect(throws: UploadError.insecureTarget) { try engine.validatedURL("https://user@s3.amazonaws.com/x") }
        #expect((try? engine.validatedURL("https://s3.amazonaws.com/x")) != nil)
    }

    @Test func allowsLocalStorageOnlyForLocalDevelopment() throws {
        let local = try #require(CapEnvironment(string: "http://localhost:3000", allowInsecureLocalhost: true))
        let engine = UploadEngine(environment: local)
        #expect((try? engine.validatedURL("http://localhost:3902/x")) != nil)
        #expect(throws: UploadError.insecureTarget) { try engine.validatedURL("http://s3.amazonaws.com/x") }
    }
}

@Suite struct DiskCacheTests {
    @Test func namespacesAndRejectsUnsafeNamespaces() async throws {
        let base = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: base) }
        let cache = DiskCache(directoryName: "snap", baseDirectory: base)
        await cache.write(["a": 1], namespace: "user_1", key: "caps/org_1")
        #expect(await cache.read([String: Int].self, namespace: "user_1", key: "caps/org_1") == ["a": 1])
        #expect(await cache.read([String: Int].self, namespace: "user_2", key: "caps/org_1") == nil)
        await cache.write(["a": 1], namespace: "../evil", key: "x")
        #expect(!FileManager.default.fileExists(atPath: base.appending(path: "evil").path()))
        await cache.removeAll()
        #expect(await cache.read([String: Int].self, namespace: "user_1", key: "caps/org_1") == nil)
    }
}

@Suite struct CaptionPhraseTests {
    let long = TranscriptCue(id: 0, start: 10, end: 20, text: "So the first thing you will notice is that the timeline now snaps clips to each other and to the playhead, which makes trimming much faster")

    @Test func shortCuesShowWhole() {
        let cue = TranscriptCue(id: 0, start: 0, end: 2, text: "Short and sweet.")
        #expect(cue.caption(at: 1) == "Short and sweet.")
    }

    @Test func longCuesSplitIntoEvenPhrasesOfWholeWords() {
        let phrases = TranscriptCue.phrases(long.text, maxCharacters: 64)
        #expect(phrases.count == 3)
        #expect(phrases.allSatisfy { $0.count <= 64 })
        #expect(phrases.joined(separator: " ") == long.text)
        let lengths = phrases.map(\.count)
        #expect((lengths.max() ?? 0) - (lengths.min() ?? 0) < 25)
    }

    @Test func phrasesFollowTheSpeech() {
        let phrases = TranscriptCue.phrases(long.text, maxCharacters: 64)
        #expect(long.caption(at: 10.2) == phrases[0])
        #expect(long.caption(at: 15) == phrases[1])
        #expect(long.caption(at: 19.9) == phrases[2])
        #expect(long.caption(at: 25) == phrases[2])
    }

    @Test func aSingleLongWordStillShows() {
        let word = String(repeating: "w", count: 90)
        #expect(TranscriptCue.phrases(word, maxCharacters: 64) == [word])
    }
}
