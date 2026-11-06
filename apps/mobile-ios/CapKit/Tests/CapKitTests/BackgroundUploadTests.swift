import Foundation
import Testing
@testable import CapKit

@Suite struct BackgroundUploadTests {
    /// The space matters: uploads stage under "Application Support", and percent-encoded paths miss it.
    private func makeDirectory() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "bg \(UUID().uuidString)/Application Support", directoryHint: .isDirectory)
    }

    private func staged(_ directory: URL, _ name: String) throws -> URL {
        let url = directory.appending(path: name)
        try Data("VIDEO".utf8).write(to: url)
        return url
    }

    private func record(_ capId: String, source: URL) -> PendingUpload {
        PendingUpload(capId: capId, shareUrl: "https://cap.so/s/\(capId)", rawFileKey: "u/\(capId)/raw-upload.mp4", contentLength: 5, title: "Clip", userId: "user_1", isImage: false, sourceFile: source.path(percentEncoded: false), temporaryBody: nil)
    }

    @Test func recordsSurviveARelaunchAndRemovalDeletesFiles() throws {
        let directory = makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let uploads = BackgroundUploads(directory: directory, configuration: .ephemeral)
        let source = try staged(directory, "a clip.mov")
        let prepared = PreparedUploadRequest(request: URLRequest(url: URL(string: "https://example.invalid/put")!), bodyFile: source, temporaryBody: nil)
        uploads.start(prepared, record: record("cap_a", source: source))

        let relaunched = BackgroundUploads(directory: directory, configuration: .ephemeral)
        #expect(relaunched.records.map(\.capId) == ["cap_a"])
        #expect(relaunched.records.first?.taskIdentifier != nil)
        #expect(relaunched.records.first?.state == .uploading)

        relaunched.remove(capId: "cap_a")
        #expect(relaunched.records.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: source.path(percentEncoded: false)))
        #expect(BackgroundUploads(directory: directory, configuration: .ephemeral).records.isEmpty)
    }

    @Test func orphanCleanupKeepsReferencedFiles() throws {
        let directory = makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let uploads = BackgroundUploads(directory: directory, configuration: .ephemeral)
        let kept = try staged(directory, "kept clip.mov")
        let orphan = try staged(directory, "orphan.mov")
        let prepared = PreparedUploadRequest(request: URLRequest(url: URL(string: "https://example.invalid/put")!), bodyFile: kept, temporaryBody: nil)
        uploads.start(prepared, record: record("cap_b", source: kept))
        uploads.removeOrphanedFiles()
        #expect(FileManager.default.fileExists(atPath: orphan.path(percentEncoded: false)), "a file still being prepared must survive")
        uploads.removeOrphanedFiles(olderThan: -1)
        #expect(FileManager.default.fileExists(atPath: kept.path(percentEncoded: false)))
        #expect(!FileManager.default.fileExists(atPath: orphan.path(percentEncoded: false)))
        #expect(uploads.records.count == 1)
    }

    @Test func cancelAllForgetsEverything() async throws {
        let directory = makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let uploads = BackgroundUploads(directory: directory, configuration: .ephemeral)
        let source = try staged(directory, "clip.mov")
        let prepared = PreparedUploadRequest(request: URLRequest(url: URL(string: "https://example.invalid/put")!), bodyFile: source, temporaryBody: nil)
        uploads.start(prepared, record: record("cap_c", source: source))
        await uploads.cancelAll()
        #expect(uploads.records.isEmpty)
        #expect(BackgroundUploads(directory: directory, configuration: .ephemeral).records.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: source.path(percentEncoded: false)))
    }

    @Test func requestsDropCredentialsAndRejectUnsafeTargets() throws {
        let directory = makeDirectory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = try staged(directory, "my clip.mp4")
        let engine = UploadEngine(environment: .production)
        let put = try engine.prepareRequest(file: file, fileName: "clip.mp4", contentType: "video/mp4", size: 5, target: .put(url: "https://r2.example.com/x", headers: ["Content-Type": "video/mp4", "Authorization": "Bearer leak", "Cookie": "a=b", "Host": "evil"]), workDirectory: directory)
        #expect(put.request.httpMethod == "PUT")
        #expect(put.request.value(forHTTPHeaderField: "Content-Type") == "video/mp4")
        #expect(put.request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(put.request.value(forHTTPHeaderField: "Cookie") == nil)
        #expect(put.bodyFile == file)
        #expect(put.temporaryBody == nil)

        let post = try engine.prepareRequest(file: file, fileName: "clip.mp4", contentType: "video/mp4", size: 5, target: .s3Post(url: "https://s3.example.com", fields: ["key": "u/v/raw.mp4"]), workDirectory: directory)
        #expect(post.request.httpMethod == "POST")
        #expect(post.temporaryBody != nil)
        #expect(post.temporaryBody?.deletingLastPathComponent().path(percentEncoded: false) == directory.path(percentEncoded: false))

        #expect(throws: UploadError.insecureTarget) {
            try engine.prepareRequest(file: file, fileName: "clip.mp4", contentType: "video/mp4", size: 5, target: .put(url: "http://r2.example.com/x", headers: [:]), workDirectory: directory)
        }
        #expect(throws: UploadError.fileUnavailable) {
            try engine.prepareRequest(file: directory.appending(path: "missing.mp4"), fileName: "x.mp4", contentType: "video/mp4", size: 5, target: .put(url: "https://r2.example.com/x", headers: [:]), workDirectory: directory)
        }
    }
}
