import CoreGraphics
import CryptoKit
import Foundation

public struct ImageRequest: Sendable, Hashable {
    public let url: URL
    public let cacheKey: String
    public let maxPixelSize: Int

    public init(url: URL, cacheKey: String? = nil, maxPixelSize: Int) {
        self.url = url
        self.cacheKey = cacheKey ?? url.absoluteString
        self.maxPixelSize = maxPixelSize
    }

    var storageKey: String {
        let digest = SHA256.hash(data: Data("\(cacheKey)@\(maxPixelSize)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

public enum ImagePipelineError: Error, Sendable {
    case invalidResponse
    case undecodable
    case tooLarge
}

final class ImageMemoryCache: @unchecked Sendable {
    private let cache = NSCache<NSString, CGImageBox>()

    init(costLimit: Int) {
        cache.totalCostLimit = costLimit
        cache.countLimit = 400
    }

    func image(for key: String) -> CGImage? {
        cache.object(forKey: key as NSString)?.image
    }

    func insert(_ image: CGImage, for key: String) {
        cache.setObject(CGImageBox(image), forKey: key as NSString, cost: image.bytesPerRow * image.height)
    }

    func removeAll() {
        cache.removeAllObjects()
    }
}

final class CGImageBox {
    let image: CGImage
    init(_ image: CGImage) { self.image = image }
}

final class ImageSessionDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    let environment: CapEnvironment

    init(environment: CapEnvironment) {
        self.environment = environment
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
        guard let url = request.url else { return nil }
        let secure = url.scheme?.lowercased() == "https" || environment.isSameOrigin(url)
        guard secure else { return nil }
        var next = request
        if !environment.isSameOrigin(url) {
            for header in ImagePipeline.privateHeaders {
                next.setValue(nil, forHTTPHeaderField: header)
            }
        }
        return next
    }
}

public final class ImagePipeline: Sendable {
    public static let maxDownloadBytes = 25 * 1024 * 1024

    private let environment: CapEnvironment
    /// Headers that only ever go to Cap's origin, never to a storage redirect.
    static let privateHeaders = ["Authorization", "X-Cap-Video-Access"]
    private let headers: @Sendable (URL) -> [String: String]
    private let session: URLSession
    private let memory = ImageMemoryCache(costLimit: 96 * 1024 * 1024)
    private let directory: URL
    private let inflight = InflightImages()

    public init(environment: CapEnvironment, headers: @escaping @Sendable (URL) -> [String: String], cacheDirectory: URL? = nil) {
        self.environment = environment
        self.headers = headers
        let configuration = URLSessionTransport.makeConfiguration()
        configuration.timeoutIntervalForRequest = 20
        configuration.httpMaximumConnectionsPerHost = 8
        session = URLSession(configuration: configuration, delegate: ImageSessionDelegate(environment: environment), delegateQueue: nil)
        let base = cacheDirectory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        directory = base.appending(path: "so.cap.mobile.images", directoryHint: .isDirectory)
    }

    public func cachedImage(for request: ImageRequest) -> CGImage? {
        memory.image(for: request.storageKey)
    }

    public func image(for request: ImageRequest) async throws -> CGImage {
        let key = request.storageKey
        if let image = memory.image(for: key) { return image }
        return try await inflight.run(key: key) { [self] in
            if let image = memory.image(for: key) { return image }
            if let image = await readDisk(key: key, maxPixelSize: request.maxPixelSize) {
                memory.insert(image, for: key)
                return image
            }
            let data = try await download(request.url)
            guard let image = ImageCoding.downsample(data: data, maxPixelSize: request.maxPixelSize) else {
                throw ImagePipelineError.undecodable
            }
            memory.insert(image, for: key)
            await writeDisk(image, key: key)
            return image
        }
    }

    public func prune(maxBytes: Int = 150 * 1024 * 1024, maxAge: TimeInterval = 30 * 24 * 60 * 60) async {
        let directory = directory
        await Task.detached(priority: .utility) {
            let keys: [URLResourceKey] = [.contentModificationDateKey, .totalFileAllocatedSizeKey]
            guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys) else { return }
            let now = Date.now
            var entries: [(url: URL, date: Date, size: Int)] = []
            for file in files {
                let values = try? file.resourceValues(forKeys: Set(keys))
                let date = values?.contentModificationDate ?? .distantPast
                if now.timeIntervalSince(date) > maxAge {
                    try? FileManager.default.removeItem(at: file)
                } else {
                    entries.append((file, date, values?.totalFileAllocatedSize ?? 0))
                }
            }
            var total = entries.reduce(0) { $0 + $1.size }
            for entry in entries.sorted(by: { $0.date < $1.date }) where total > maxBytes {
                try? FileManager.default.removeItem(at: entry.url)
                total -= entry.size
            }
        }.value
    }

    public func removeAll() async {
        memory.removeAll()
        await inflight.cancelAll()
        try? FileManager.default.removeItem(at: directory)
    }

    public func text(from url: URL, maxBytes: Int = 4 * 1024 * 1024) async throws -> String {
        let data = try await download(url, accept: "text/vtt, text/plain, */*")
        guard data.count <= maxBytes else { throw ImagePipelineError.tooLarge }
        guard let text = String(data: data, encoding: .utf8) else { throw ImagePipelineError.undecodable }
        return text
    }

    private func download(_ url: URL, accept: String = "image/*") async throws -> Data {
        guard SafeURL.media(url.absoluteString, environment: environment) != nil else { throw ImagePipelineError.invalidResponse }
        var request = URLRequest(url: url)
        request.setValue(accept, forHTTPHeaderField: "Accept")
        for (field, value) in headers(url) {
            request.setValue(value, forHTTPHeaderField: field)
        }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ImagePipelineError.invalidResponse
        }
        guard http.expectedContentLength <= Int64(Self.maxDownloadBytes) else { throw ImagePipelineError.tooLarge }
        var data = Data()
        if http.expectedContentLength > 0 { data.reserveCapacity(Int(http.expectedContentLength)) }
        for try await byte in bytes {
            data.append(byte)
            if data.count > Self.maxDownloadBytes { throw ImagePipelineError.tooLarge }
        }
        return data
    }

    private func readDisk(key: String, maxPixelSize: Int) async -> CGImage? {
        let url = directory.appending(path: "\(key).jpg")
        return await Task.detached(priority: .userInitiated) {
            guard FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) else { return nil }
            return ImageCoding.downsample(fileURL: url, maxPixelSize: maxPixelSize)
        }.value
    }

    private func writeDisk(_ image: CGImage, key: String) async {
        let directory = directory
        await Task.detached(priority: .utility) {
            guard let data = ImageCoding.jpegData(from: image, quality: 0.82) else { return }
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                var url = directory.appending(path: "\(key).jpg")
                try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try? url.setResourceValues(values)
            } catch {}
        }.value
    }
}

actor InflightImages {
    private var tasks: [String: Task<CGImage, any Error>] = [:]

    func run(key: String, operation: @escaping @Sendable () async throws -> CGImage) async throws -> CGImage {
        if let task = tasks[key] { return try await task.value }
        let task = Task { try await operation() }
        tasks[key] = task
        defer { tasks[key] = nil }
        return try await task.value
    }

    func cancelAll() {
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
    }
}
