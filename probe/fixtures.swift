import AppKit
import Foundation

// usage: swift fixtures.swift <outdir>
let out = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ name: String, _ w: Int, _ h: Int, _ bg: NSColor = .white, _ draw: (CGContext) -> Void) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 32)!
    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = ctx
    let cg = ctx.cgContext
    cg.setFillColor(bg.cgColor)
    cg.fill(CGRect(x: 0, y: 0, width: w, height: h))
    // Flip so y grows downward like the image.
    cg.translateBy(x: 0, y: CGFloat(h))
    cg.scaleBy(x: 1, y: -1)
    draw(cg)
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent(name))
}

func text(_ s: String, _ x: CGFloat, _ y: CGFloat, _ size: CGFloat, mono: Bool = false,
          color: NSColor = .black, angle: CGFloat = 0, in cg: CGContext) {
    let font = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
                    : NSFont.systemFont(ofSize: size)
    let attr = NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: color])
    cg.saveGState()
    cg.translateBy(x: x, y: y)
    cg.rotate(by: angle)
    // Undo the flip for glyphs.
    cg.scaleBy(x: 1, y: -1)
    let line = CTLineCreateWithAttributedString(attr)
    cg.textPosition = CGPoint(x: 0, y: 0)
    CTLineDraw(line, cg)
    cg.restoreGState()
}

// 1. Mixed content at 2x (a Retina capture of a 1440x900 window).
render("mixed-2x.png", 2880, 1800) { cg in
    let s: CGFloat = 2
    text("Copy text from a screenshot", 80 * s, 90 * s, 34 * s, in: cg)
    text("The quick brown fox jumps over the lazy dog.", 80 * s, 150 * s, 20 * s, in: cg)
    text("let total = items.iter().map(|item| item.price).sum::<u64>();", 80 * s, 210 * s, 16 * s, mono: true, in: cg)
    text("Größenänderung übernehmen und Änderungen speichern", 80 * s, 270 * s, 20 * s, in: cg)
    text("日本語のテキスト認識をテストします", 80 * s, 330 * s, 22 * s, in: cg)
    text("简体中文文本识别测试", 80 * s, 390 * s, 22 * s, in: cg)
    text("Small print: version 0.6.4 build 2026-11-14", 80 * s, 440 * s, 9 * s, color: .darkGray, in: cg)
    text("Rotated label at eight degrees", 760 * s, 520 * s, 24 * s, angle: -8 * .pi / 180, in: cg)
    text("Second column heading", 900 * s, 150 * s, 20 * s, in: cg)
    text("Right column body line", 900 * s, 210 * s, 16 * s, in: cg)
    cg.setFillColor(NSColor(calibratedWhite: 0.12, alpha: 1).cgColor)
    cg.fill(CGRect(x: 80 * s, y: 600 * s, width: 400 * s, height: 80 * s))
    text("White on dark", 110 * s, 650 * s, 24 * s, color: .white, in: cg)
}

// 2. 8K with many words.
render("dense-8k.png", 7680, 4320) { cg in
    let words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
                 "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa"]
    var i = 0
    for col in 0..<3 {
        for row in 0..<120 {
            var line = "\(col * 120 + row + 1)."
            for _ in 0..<10 { line += " " + words[i % words.count]; i += 1 }
            text(line, CGFloat(80 + col * 2500), CGFloat(60 + row * 35), 22, in: cg)
        }
    }
}

// 3. Tall scrolling page, small text relative to height.
render("tall.png", 1600, 12000) { cg in
    for row in 0..<300 {
        text("Line \(row + 1) of a long scrolling capture with ordinary body text", 60, CGFloat(60 + row * 39), 18, in: cg)
    }
}

// 4. No text at all.
render("blank.png", 1920, 1080, NSColor(calibratedRed: 0.2, green: 0.45, blue: 0.8, alpha: 1)) { cg in
    for k in 0..<40 {
        cg.setFillColor(NSColor(calibratedHue: CGFloat(k) / 40, saturation: 0.6, brightness: 0.9, alpha: 0.5).cgColor)
        cg.fillEllipse(in: CGRect(x: k * 45, y: (k * 97) % 900, width: 160, height: 160))
    }
}

// 5. The committed test fixture: small, three lines, two words each side.
render("ocr-lines.png", 720, 240) { cg in
    text("Hello Cap world", 30, 60, 32, in: cg)
    text("second line here", 30, 130, 32, in: cg)
    text("Copy this text 42", 30, 200, 32, in: cg)
}
print("ok")
