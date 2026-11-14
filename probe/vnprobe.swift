import AppKit
import Vision

// usage: vnprobe <png>...
// Mirrors screenshot_ocr.rs: decode, accurate + language correction +
// revision 3 + automatic language, then one boundingBox(for:) per
// whitespace-separated word.
for path in CommandLine.arguments.dropFirst() {
    let t0 = Date()
    let src = NSImage(contentsOfFile: path)!.cgImage(forProposedRect: nil, context: nil, hints: nil)!
    let decodeMs = Int(Date().timeIntervalSince(t0) * 1000)
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    req.revision = VNRecognizeTextRequestRevision3
    req.automaticallyDetectsLanguage = true
    let t1 = Date()
    do {
        try VNImageRequestHandler(cgImage: src, options: [:]).perform([req])
    } catch {
        print("\((path as NSString).lastPathComponent) \(src.width)x\(src.height): ERROR \(error)")
        continue
    }
    let recognizeMs = Int(Date().timeIntervalSince(t1) * 1000)
    let t2 = Date()
    var words = 0
    var boxed = 0
    let obs = req.results ?? []
    for o in obs {
        guard let c = o.topCandidates(1).first else { continue }
        let s = c.string
        var i = s.startIndex
        while i < s.endIndex {
            while i < s.endIndex, s[i].isWhitespace { i = s.index(after: i) }
            var j = i
            while j < s.endIndex, !s[j].isWhitespace { j = s.index(after: j) }
            if i < j {
                words += 1
                if (try? c.boundingBox(for: i..<j)) != nil { boxed += 1 }
            }
            i = j
        }
    }
    let boxMs = Int(Date().timeIntervalSince(t2) * 1000)
    let sample = obs.prefix(12).map { $0.topCandidates(1).first?.string ?? "" }
    print("\((path as NSString).lastPathComponent) \(src.width)x\(src.height): decode=\(decodeMs)ms recognize=\(recognizeMs)ms wordboxes=\(boxMs)ms lines=\(obs.count) words=\(words) boxed=\(boxed)")
    print("  \(sample)")
}
