import AppKit
import Vision

setvbuf(stdout, nil, _IOLBF, 0)

// usage: vnmodes <png>...  Whole-image pass, then the tiling screenshot_ocr.rs
// uses (2048 tiles, 256 overlap, last tile flush with the far edge).
func run(_ img: CGImage) -> Int {
    autoreleasepool {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = true
        req.revision = VNRecognizeTextRequestRevision3
        req.automaticallyDetectsLanguage = true
        do { try VNImageRequestHandler(cgImage: img, options: [:]).perform([req]) } catch {
            print("  error \(error)")
            return 0
        }
        return req.results?.count ?? 0
    }
}

func starts(_ length: Int, _ side: Int, _ overlap: Int) -> [Int] {
    if length <= side { return [0] }
    var out: [Int] = []
    var s = 0
    while s + side < length { out.append(s); s += side - overlap }
    out.append(length - side)
    return out
}

for path in CommandLine.arguments.dropFirst() {
    let name = (path as NSString).lastPathComponent
    guard let src = NSImage(contentsOfFile: path)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("\(name): cannot load"); continue
    }
    var t = Date()
    let whole = run(src)
    print("\(name) \(src.width)x\(src.height) whole: lines=\(whole) \(Int(Date().timeIntervalSince(t) * 1000))ms")
    t = Date()
    var lines = 0
    var tiles = 0
    for y in starts(src.height, 2048, 256) {
        for x in starts(src.width, 2048, 256) {
            let rect = CGRect(x: x, y: y, width: min(2048, src.width), height: min(2048, src.height))
            if let tile = src.cropping(to: rect) { lines += run(tile); tiles += 1 }
        }
    }
    print("\(name) tiled(\(tiles)): lines=\(lines) \(Int(Date().timeIntervalSince(t) * 1000))ms")
}
