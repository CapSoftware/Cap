import AppKit
import Vision

// usage: vnmodes <png>...  Tries default, explicit minimumTextHeight values,
// and tiling, and prints lines found and time for each.
func run(_ img: CGImage, minHeight: Float?) throws -> [VNRecognizedTextObservation] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    req.revision = VNRecognizeTextRequestRevision3
    req.automaticallyDetectsLanguage = true
    if let m = minHeight { req.minimumTextHeight = m }
    try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    return req.results ?? []
}

for path in CommandLine.arguments.dropFirst() {
    let src = NSImage(contentsOfFile: path)!.cgImage(forProposedRect: nil, context: nil, hints: nil)!
    let name = (path as NSString).lastPathComponent
    for m: Float? in [nil, 0, 0.002, 0.005] {
        let t = Date()
        let r = (try? run(src, minHeight: m)) ?? []
        print("\(name) min=\(m.map { "\($0)" } ?? "default"): lines=\(r.count) \(Int(Date().timeIntervalSince(t) * 1000))ms sample=\(r.prefix(2).map { $0.topCandidates(1).first?.string ?? "" })")
    }
    for side in [2048, 3072] {
        let t = Date()
        var lines = 0
        let step = side * 9 / 10
        var y = 0
        while y < src.height {
            var x = 0
            while x < src.width {
                let rect = CGRect(x: x, y: y, width: min(side, src.width - x), height: min(side, src.height - y))
                if let tile = src.cropping(to: rect) { lines += ((try? run(tile, minHeight: nil)) ?? []).count }
                if x + side >= src.width { break }
                x += step
            }
            if y + side >= src.height { break }
            y += step
        }
        print("\(name) tiles=\(side): lines=\(lines) \(Int(Date().timeIntervalSince(t) * 1000))ms")
    }
}
