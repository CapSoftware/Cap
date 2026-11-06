import Foundation

public enum CapFormat {
    public static func duration(_ seconds: Double?) -> String? {
        guard let seconds, seconds.isFinite, seconds >= 0 else { return nil }
        return timestamp(seconds)
    }

    public static func timestamp(_ seconds: Double) -> String {
        let total = Int(max(0, seconds.isFinite ? seconds : 0).rounded(.down))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, secs)
        }
        return String(format: "%d:%02d", minutes, secs)
    }

    public static func count(_ value: Int) -> String {
        value.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)))
    }

    public static func relative(_ date: Date, now: Date = .now) -> String {
        let interval = now.timeIntervalSince(date)
        if interval < 60 && interval > -60 { return "Just now" }
        return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }

    public static func percentage(_ value: Double) -> String {
        let fraction = value > 1 ? value / 100 : value
        return fraction.formatted(.percent.precision(.fractionLength(0...1)))
    }

    public static func flag(forRegionCode code: String) -> String? {
        let upper = code.uppercased()
        guard upper.count == 2, upper.unicodeScalars.allSatisfy({ ("A"..."Z").contains($0) }) else { return nil }
        let scalars = upper.unicodeScalars.compactMap { UnicodeScalar(127397 + $0.value) }
        return String(String.UnicodeScalarView(scalars))
    }

    public static func regionName(forCode code: String, locale: Locale = .current) -> String {
        locale.localizedString(forRegionCode: code.uppercased()) ?? code
    }

    public static func byteCount(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}

public struct TranscriptCue: Sendable, Hashable, Identifiable {
    public let id: Int
    public let start: Double
    public let end: Double
    public let text: String
}

extension TranscriptCue {
    /// The part of the cue to show at a time. Long cues are shown a phrase at a time, in step with the speech, so a
    /// caption never grows past about two short lines.
    public func caption(at time: Double, maxCharacters: Int = 64) -> String {
        let phrases = Self.phrases(text, maxCharacters: maxCharacters)
        guard phrases.count > 1, end > start else { return phrases.first ?? text }
        let total = phrases.reduce(0) { $0 + $1.count }
        let spoken = (time - start) / (end - start) * Double(total)
        var reached = 0.0
        for phrase in phrases {
            reached += Double(phrase.count)
            if spoken < reached { return phrase }
        }
        return phrases[phrases.count - 1]
    }

    /// Splits text into evenly sized runs of whole words, none longer than the limit unless a single word is.
    static func phrases(_ text: String, maxCharacters: Int) -> [String] {
        let words = text.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return [] }
        let length = words.joined(separator: " ").count
        guard length > maxCharacters else { return [words.joined(separator: " ")] }
        let count = Int((Double(length) / Double(maxCharacters)).rounded(.up))
        let target = Double(length) / Double(count)
        var phrases: [String] = []
        var current: [String] = []
        var currentLength = 0
        for word in words {
            let added = currentLength == 0 ? word.count : currentLength + 1 + word.count
            if currentLength > 0, added > maxCharacters || (Double(added) > target && phrases.count < count - 1 && Double(currentLength) >= target * 0.6) {
                phrases.append(current.joined(separator: " "))
                current = [word]
                currentLength = word.count
            } else {
                current.append(word)
                currentLength = added
            }
        }
        if !current.isEmpty { phrases.append(current.joined(separator: " ")) }
        return phrases
    }
}

public enum WebVTT {
    public static func parse(_ source: String) -> [TranscriptCue] {
        let normalized = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        var cues: [TranscriptCue] = []
        for block in normalized.components(separatedBy: "\n\n") {
            let lines = block.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
            guard let timingIndex = lines.firstIndex(where: { $0.contains("-->") }) else { continue }
            let parts = lines[timingIndex].components(separatedBy: "-->")
            guard parts.count == 2,
                  let start = parseTime(parts[0]),
                  let end = parseTime(parts[1].split(separator: " ", omittingEmptySubsequences: true).first.map(String.init) ?? "")
            else { continue }
            let text = lines[(timingIndex + 1)...]
                .joined(separator: " ")
                .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            cues.append(TranscriptCue(id: cues.count, start: start, end: end, text: text))
        }
        return cues
    }

    static func parseTime(_ raw: String) -> Double? {
        let value = raw.trimmingCharacters(in: .whitespaces)
        let pieces = value.split(separator: ":").map(String.init)
        guard (2...3).contains(pieces.count) else { return nil }
        var seconds = 0.0
        for piece in pieces.dropLast() {
            guard let number = Int(piece) else { return nil }
            seconds = seconds * 60 + Double(number)
        }
        guard let last = Double(pieces.last!.replacingOccurrences(of: ",", with: ".")) else { return nil }
        return seconds * 60 + last
    }
}
