// Renders Apple's own glass (NSGlassEffectView, macOS 26+) over a fixed set
// of backdrops and captures each window, so Cap's glass renderer can be
// compared against it pixel for pixel. Writes <out>/scenes/<scene>.png (the
// bare backdrop), <out>/apple/<case>.png and <out>/manifest.json.
//
//   swiftc -O reference.swift -o reference && ./reference <out dir>
//
// Needs Screen Recording for the calling process (screencapture -l).
import AppKit

let canvas = NSSize(width: 960, height: 600)

struct Shape {
    let name: String
    let rect: NSRect
    let radius: CGFloat
}

// Rects are in points with a top-left origin, matching the manifest.
let shapes: [Shape] = [
    Shape(name: "capsule", rect: NSRect(x: 60, y: 60, width: 320, height: 120), radius: 60),
    Shape(name: "panel", rect: NSRect(x: 460, y: 60, width: 420, height: 240), radius: 24),
    Shape(name: "toolbar", rect: NSRect(x: 60, y: 260, width: 300, height: 48), radius: 24),
    Shape(name: "circle", rect: NSRect(x: 120, y: 380, width: 96, height: 96), radius: 48),
    Shape(name: "card", rect: NSRect(x: 460, y: 380, width: 360, height: 160), radius: 16),
]

func drawScene(_ name: String, in ctx: CGContext, size: NSSize) {
    let rect = CGRect(origin: .zero, size: size)
    func fill(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) {
        ctx.setFillColor(CGColor(srgbRed: r, green: g, blue: b, alpha: 1))
        ctx.fill(rect)
    }
    func text(_ color: NSColor) {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 4
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 15, weight: .regular),
            .foregroundColor: color,
            .paragraphStyle: style,
        ]
        let line = "The quick brown fox jumps over the lazy dog 0123456789 — Cap records, edits and shares. "
        let body = String(repeating: line, count: 40)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
        (body as NSString).draw(in: rect.insetBy(dx: 24, dy: 24), withAttributes: attrs)
        NSGraphicsContext.restoreGraphicsState()
    }
    switch name {
    case "white": fill(1, 1, 1)
    case "black": fill(0, 0, 0)
    case "gray": fill(0.5, 0.5, 0.5)
    case "text":
        fill(1, 1, 1)
        text(.black)
    case "darktext":
        fill(0.08, 0.08, 0.09)
        text(.white)
    case "stripes":
        fill(1, 1, 1)
        ctx.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1))
        var x: CGFloat = 0
        while x < size.width {
            ctx.fill(CGRect(x: x, y: 0, width: 8, height: size.height))
            x += 16
        }
    case "grid":
        fill(0.96, 0.96, 0.97)
        ctx.setStrokeColor(CGColor(srgbRed: 0.1, green: 0.3, blue: 0.9, alpha: 1))
        ctx.setLineWidth(2)
        var v: CGFloat = 0
        while v <= max(size.width, size.height) {
            ctx.move(to: CGPoint(x: v, y: 0)); ctx.addLine(to: CGPoint(x: v, y: size.height))
            ctx.move(to: CGPoint(x: 0, y: v)); ctx.addLine(to: CGPoint(x: size.width, y: v))
            v += 24
        }
        ctx.strokePath()
    case "checker":
        let cell: CGFloat = 32
        for row in 0..<Int(size.height / cell) + 1 {
            for col in 0..<Int(size.width / cell) + 1 {
                let on = (row + col) % 2 == 0
                ctx.setFillColor(on ? CGColor(srgbRed: 0.95, green: 0.32, blue: 0.2, alpha: 1)
                                    : CGColor(srgbRed: 0.12, green: 0.55, blue: 0.95, alpha: 1))
                ctx.fill(CGRect(x: CGFloat(col) * cell, y: CGFloat(row) * cell, width: cell, height: cell))
            }
        }
    case "hues":
        let colors = (0...6).map { i -> CGColor in
            NSColor(calibratedHue: CGFloat(i) / 6, saturation: 0.85, brightness: 0.95, alpha: 1).cgColor
        }
        let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: nil)!
        ctx.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: 0), options: [])
    case "blobs":
        fill(0.98, 0.94, 0.88)
        let blobs: [(CGFloat, CGFloat, CGFloat, CGColor)] = [
            (0.2, 0.3, 260, CGColor(srgbRed: 1.0, green: 0.35, blue: 0.45, alpha: 1)),
            (0.7, 0.25, 300, CGColor(srgbRed: 0.25, green: 0.55, blue: 1.0, alpha: 1)),
            (0.5, 0.8, 280, CGColor(srgbRed: 0.2, green: 0.85, blue: 0.55, alpha: 1)),
            (0.9, 0.8, 220, CGColor(srgbRed: 1.0, green: 0.8, blue: 0.2, alpha: 1)),
        ]
        for (fx, fy, radius, color) in blobs {
            let center = CGPoint(x: fx * size.width, y: fy * size.height)
            let clear = color.copy(alpha: 0)!
            let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [color, clear] as CFArray, locations: [0, 1])!
            ctx.drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
        }
    default: fill(1, 0, 1)
    }
}

let scenes = ["white", "black", "gray", "text", "darktext", "stripes", "grid", "checker", "hues", "blobs"]
let styles: [(String, NSGlassEffectView.Style)] = [("regular", .regular), ("clear", .clear)]
let appearances: [(String, NSAppearance.Name)] = [("light", .aqua), ("dark", .darkAqua)]
let tints: [(String, NSColor?)] = [("none", nil), ("blue", NSColor.systemBlue.withAlphaComponent(0.6))]

final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

func renderScene(_ name: String, scale: CGFloat) -> CGImage {
    let width = Int(canvas.width * scale), height = Int(canvas.height * scale)
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.scaleBy(x: scale, y: scale)
    drawScene(name, in: ctx, size: canvas)
    return ctx.makeImage()!
}

func writePNG(_ image: CGImage, to url: URL) {
    let rep = NSBitmapImageRep(cgImage: image)
    try! rep.representation(using: .png, properties: [:])!.write(to: url)
}

func pump(_ seconds: TimeInterval) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
}

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "glass-reference")
try FileManager.default.createDirectory(at: out.appendingPathComponent("scenes"), withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: out.appendingPathComponent("apple"), withIntermediateDirectories: true)

let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.finishLaunching()

let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: 80, y: 80), size: canvas),
                      styleMask: [.borderless], backing: .buffered, defer: false)
window.isOpaque = true
window.hasShadow = false
window.level = .floating
let root = FlippedView(frame: NSRect(origin: .zero, size: canvas))
window.contentView = root
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
pump(1.0)

let scale = window.backingScaleFactor
var cases: [[String: Any]] = []
let backdrop = NSImageView(frame: root.bounds)
backdrop.imageScaling = .scaleAxesIndependently
root.addSubview(backdrop)

for scene in scenes {
    let image = renderScene(scene, scale: scale)
    writePNG(image, to: out.appendingPathComponent("scenes/\(scene).png"))
    backdrop.image = NSImage(cgImage: image, size: canvas)
    for (styleName, style) in styles {
        for (appearanceName, appearance) in appearances {
            for (tintName, tint) in tints {
                if tintName != "none" && !(scene == "white" || scene == "blobs" || scene == "black") {
                    continue
                }
                window.appearance = NSAppearance(named: appearance)
                var views: [NSView] = []
                for shape in shapes {
                    let glass = NSGlassEffectView(frame: shape.rect)
                    glass.style = style
                    glass.cornerRadius = shape.radius
                    glass.tintColor = tint
                    root.addSubview(glass)
                    views.append(glass)
                }
                pump(0.6)
                let name = "\(scene)-\(styleName)-\(appearanceName)-\(tintName)"
                let path = out.appendingPathComponent("apple/\(name).png").path
                let capture = Process()
                capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                capture.arguments = ["-x", "-o", "-l\(window.windowNumber)", path]
                try capture.run()
                capture.waitUntilExit()
                cases.append([
                    "name": name, "scene": scene, "style": styleName,
                    "appearance": appearanceName, "tint": tintName,
                ])
                views.forEach { $0.removeFromSuperview() }
            }
        }
    }
}

let manifest: [String: Any] = [
    "canvas": [canvas.width, canvas.height],
    "scale": scale,
    "os": ProcessInfo.processInfo.operatingSystemVersionString,
    "shapes": shapes.map { ["name": $0.name, "rect": [$0.rect.minX, $0.rect.minY, $0.rect.width, $0.rect.height], "radius": $0.radius] },
    "tints": ["blue": [0.0, 0.533, 1.0, 0.6]],
    "cases": cases,
]
let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
try data.write(to: out.appendingPathComponent("manifest.json"))
print("wrote \(cases.count) cases to \(out.path)")
