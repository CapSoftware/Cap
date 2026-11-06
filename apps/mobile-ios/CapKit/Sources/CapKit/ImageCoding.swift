import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

public struct EncodedImage: Sendable, Hashable {
    public let data: Data
    public let contentType: String
    public let fileName: String

    struct Payload: Encodable {
        let data: String
        let contentType: String
        let fileName: String
    }

    var payload: Payload {
        Payload(data: data.base64EncodedString(), contentType: contentType, fileName: fileName)
    }
}

public enum ImageCodingError: Error, Sendable, Equatable, LocalizedError {
    case unreadable
    case tooLarge

    public var errorDescription: String? {
        switch self {
        case .unreadable: "That image couldn't be read. Choose another one."
        case .tooLarge: "That image is too large. Choose a smaller one."
        }
    }
}

public enum ImageCoding {
    public static let uploadByteLimit = 1024 * 1024

    public static func downsample(data: Data, maxPixelSize: Int) -> CGImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
        return downsample(source: source, maxPixelSize: maxPixelSize)
    }

    public static func downsample(fileURL: URL, maxPixelSize: Int) -> CGImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithURL(fileURL as CFURL, sourceOptions) else { return nil }
        return downsample(source: source, maxPixelSize: maxPixelSize)
    }

    private static func downsample(source: CGImageSource, maxPixelSize: Int) -> CGImage? {
        guard CGImageSourceGetCount(source) > 0 else { return nil }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, maxPixelSize),
        ] as [CFString: Any] as CFDictionary
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options)
    }

    public static func jpegData(from image: CGImage, quality: Double) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        let properties = [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        CGImageDestinationAddImage(destination, image, properties)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }

    /// Re-encodes a photo for a screenshot Cap. Re-encoding drops EXIF, GPS and maker metadata;
    /// 4096 px keeps text sharp while bounding the upload.
    public static func encodeScreenshot(fileURL: URL, maxPixelSize: Int = 4096) throws(ImageCodingError) -> Data {
        guard let image = downsample(fileURL: fileURL, maxPixelSize: maxPixelSize),
              let jpeg = jpegData(from: image, quality: 0.9)
        else { throw .unreadable }
        return jpeg
    }

    public static func encodeForUpload(_ data: Data, maxPixelSize: Int = 1024, fileName: String = "image.jpg") throws(ImageCodingError) -> EncodedImage {
        guard let image = downsample(data: data, maxPixelSize: maxPixelSize) else { throw .unreadable }
        for quality in [0.86, 0.78, 0.68, 0.56, 0.45] {
            if let jpeg = jpegData(from: image, quality: quality), jpeg.count <= uploadByteLimit {
                return EncodedImage(data: jpeg, contentType: "image/jpeg", fileName: fileName)
            }
        }
        if maxPixelSize > 512 {
            return try encodeForUpload(data, maxPixelSize: maxPixelSize / 2, fileName: fileName)
        }
        throw .tooLarge
    }
}
