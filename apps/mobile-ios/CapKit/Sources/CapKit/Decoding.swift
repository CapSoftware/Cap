import Foundation

public protocol UnknownCaseDecodable: RawRepresentable, Codable, Sendable, Hashable where RawValue == String {
    static var unknownCase: Self { get }
}

extension UnknownCaseDecodable {
    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? Self.unknownCase
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

struct LossyElement<Element: Decodable>: Decodable {
    let value: Element?

    init(from decoder: any Decoder) throws {
        value = try? Element(from: decoder)
    }
}

extension KeyedDecodingContainer {
    func decodeLossyArray<Element: Decodable>(_ type: Element.Type, forKey key: Key) throws -> [Element] {
        guard contains(key), try decodeNil(forKey: key) == false else { return [] }
        return try decode([LossyElement<Element>].self, forKey: key).compactMap(\.value)
    }

    func decodeNumber(forKey key: Key) throws -> Double {
        if let value = try? decode(Double.self, forKey: key) { return value }
        return Double(try decode(Int.self, forKey: key))
    }

    func decodeCount(forKey key: Key) throws -> Int {
        let value = try decodeNumber(forKey: key)
        guard value.isFinite else { return 0 }
        return Int(max(0, min(value, Double(Int32.max))).rounded())
    }
}

public enum CapJSON {
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let whole = Date.ISO8601FormatStyle()

    public static func parseDate(_ value: String) -> Date? {
        if let date = try? fractional.parse(value) { return date }
        if let date = try? whole.parse(value) { return date }
        return nil
    }

    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = parseDate(value) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO 8601 date")
            }
            return date
        }
        return decoder
    }

    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
