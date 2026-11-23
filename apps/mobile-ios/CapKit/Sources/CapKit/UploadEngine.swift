import Foundation

public enum UploadError: Error, Sendable, Equatable, LocalizedError {
    case insecureTarget
    case fileUnavailable
    case rejected(status: Int)
    case transport(CapAPIError)

    public var errorDescription: String? {
        switch self {
        case .insecureTarget: "Cap returned an upload destination this app can't trust."
        case .fileUnavailable: "The video file is no longer available."
        case .rejected: "Storage rejected the upload. Try again."
        case let .transport(error): error.errorDescription
        }
    }
}

public enum MultipartBody {
    public static func write(fields: [String: String], fileURL: URL, fileName: String, contentType: String, boundary: String, to destination: URL) throws {
        FileManager.default.createFile(atPath: destination.path(percentEncoded: false), contents: nil, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }

        func append(_ string: String) throws {
            try output.write(contentsOf: Data(string.utf8))
        }

        for key in fields.keys.sorted() {
            try append("--\(boundary)\r\n")
            try append("Content-Disposition: form-data; name=\"\(sanitize(key))\"\r\n\r\n")
            try append("\(fields[key] ?? "")\r\n")
        }
        try append("--\(boundary)\r\n")
        try append("Content-Disposition: form-data; name=\"file\"; filename=\"\(sanitize(fileName))\"\r\n")
        try append("Content-Type: \(sanitize(contentType))\r\n\r\n")

        let input = try FileHandle(forReadingFrom: fileURL)
        defer { try? input.close() }
        while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty {
            try output.write(contentsOf: chunk)
        }
        try append("\r\n--\(boundary)--\r\n")
    }

    static func sanitize(_ value: String) -> String {
        String(value.unicodeScalars.filter { $0 != "\"" && $0 != "\r" && $0 != "\n" && $0.value >= 0x20 }.map(Character.init))
    }
}

public struct PreparedUploadRequest: Sendable {
    public let request: URLRequest
    public let bodyFile: URL
    public let temporaryBody: URL?
}

public final class UploadEngine: Sendable {
    private let environment: CapEnvironment
    private static let reservedHeaders: Set<String> = ["host", "content-length", "connection", "transfer-encoding", "authorization", "cookie"]

    public init(environment: CapEnvironment) {
        self.environment = environment
    }

    func validatedURL(_ string: String) throws(UploadError) -> URL {
        guard let url = URL(string: string), url.host() != nil, url.user() == nil else { throw .insecureTarget }
        if url.scheme?.lowercased() == "https" { return url }
        if url.scheme?.lowercased() == "http", environment.baseURL.scheme == "http",
           let host = url.host()?.lowercased(), CapEnvironment.isLocalDevelopmentHost(host) {
            return url
        }
        throw .insecureTarget
    }

    /// Only https targets are accepted (plus localhost in debug builds), and Cap's own credentials and
    /// hop-by-hop headers are never forwarded.
    public func prepareRequest(
        file: URL,
        fileName: String,
        contentType: String,
        size: Int64,
        target: UploadTarget,
        workDirectory: URL
    ) throws(UploadError) -> PreparedUploadRequest {
        guard FileManager.default.isReadableFile(atPath: file.path(percentEncoded: false)) else { throw .fileUnavailable }
        let url = try validatedURL(target.url)
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false

        switch target {
        case let .s3Post(_, fields):
            let boundary = "CapBoundary-\(UUID().uuidString)"
            let destination = workDirectory.appending(path: "\(UUID().uuidString).multipart")
            do {
                try MultipartBody.write(fields: fields, fileURL: file, fileName: fileName, contentType: contentType, boundary: boundary, to: destination)
            } catch {
                try? FileManager.default.removeItem(at: destination)
                throw .fileUnavailable
            }
            request.httpMethod = "POST"
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            return PreparedUploadRequest(request: request, bodyFile: destination, temporaryBody: destination)
        case let .put(_, headers):
            request.httpMethod = "PUT"
            apply(headers, to: &request)
            return PreparedUploadRequest(request: request, bodyFile: file, temporaryBody: nil)
        case let .driveResumable(_, headers):
            request.httpMethod = "PUT"
            apply(headers, to: &request)
            if size > 0 {
                request.setValue("bytes 0-\(size - 1)/\(size)", forHTTPHeaderField: "Content-Range")
            }
            return PreparedUploadRequest(request: request, bodyFile: file, temporaryBody: nil)
        }
    }

    private func apply(_ headers: [String: String], to request: inout URLRequest) {
        for (key, value) in headers where !Self.reservedHeaders.contains(key.lowercased()) {
            request.setValue(value, forHTTPHeaderField: key)
        }
    }
}
