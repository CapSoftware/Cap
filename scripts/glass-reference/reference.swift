// Renders Apple's own glass (NSGlassEffectView, macOS 26+) over a fixed set
// of backdrops and captures each window, so Cap's glass renderer can be
// compared against it pixel for pixel. Writes <out>/scenes/<scene>.png (the
// bare backdrop), <out>/apple/<case>.png and <out>/manifest.json.
//
//   swiftc -O reference.swift -o reference && ./reference <out dir>
//
// Needs Screen Recording for the calling process (screencapture -l).
import AppKit
import Metal
import SwiftUI

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
    case "uv":
        // R and G encode the sampled point, so a capture reads back where
        // each glass pixel's light came from.
        let width = Int(size.width), height = Int(size.height)
        for row in 0..<height {
            for col in 0..<width {
                ctx.setFillColor(CGColor(srgbRed: CGFloat(col) / CGFloat(width - 1),
                                         green: CGFloat(row) / CGFloat(height - 1), blue: 0.5, alpha: 1))
                ctx.fill(CGRect(x: col, y: row, width: 1, height: 1))
            }
        }
    case "uvfine":
        let width = Int(size.width), height = Int(size.height)
        for row in 0..<height {
            for col in 0..<width {
                ctx.setFillColor(CGColor(srgbRed: CGFloat(col % 32) / 31, green: CGFloat(row % 32) / 31, blue: 0.5, alpha: 1))
                ctx.fill(CGRect(x: col, y: row, width: 1, height: 1))
            }
        }
    case "split":
        fill(0, 0, 0)
        ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: size.width, height: size.height / 2))
        ctx.fill(CGRect(x: 0, y: 0, width: 170, height: size.height))
        ctx.fill(CGRect(x: 670, y: 0, width: size.width - 670, height: size.height))
    case "dots":
        fill(0, 0, 0)
        ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
        var y: CGFloat = 12
        while y < size.height {
            var x: CGFloat = 12
            while x < size.width {
                ctx.fill(CGRect(x: x, y: y, width: 2, height: 2))
                x += 40
            }
            y += 40
        }
    default: fill(1, 0, 1)
    }
}

let scenes = ["white", "black", "gray", "text", "darktext", "stripes", "grid", "checker", "hues", "blobs", "uv", "uvfine", "split", "dots"]
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

func capture(_ window: NSWindow, to url: URL) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-o", "-l\(window.windowNumber)", url.path]
    try! process.run()
    process.waitUntilExit()
    let convert = Process()
    convert.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
    convert.arguments = ["--matchTo", "/System/Library/ColorSync/Profiles/sRGB Profile.icc", url.path]
    convert.standardOutput = FileHandle.nullDevice
    try! convert.run()
    convert.waitUntilExit()
}

struct ControlsPanel: View {
    @State var on = true
    @State var off = false
    @State var level = 0.35
    @State var choice = 1
    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            HStack(spacing: 28) {
                Toggle("", isOn: $on).toggleStyle(.switch).labelsHidden()
                Toggle("", isOn: $off).toggleStyle(.switch).labelsHidden()
                Toggle("", isOn: $on).toggleStyle(.switch).labelsHidden().controlSize(.large)
            }
            Slider(value: $level).frame(width: 320)
            Picker("", selection: $choice) {
                Text("Free").tag(0)
                Text("16:9").tag(1)
                Text("4:3").tag(2)
                Text("1:1").tag(3)
            }
            .pickerStyle(.segmented).labelsHidden().frame(width: 320)
            HStack(spacing: 20) {
                Button("Glass") {}.buttonStyle(.glass)
                Button("Prominent") {}.buttonStyle(.glassProminent)
                Button("Large") {}.buttonStyle(.glass).controlSize(.large)
                Button {} label: { Image(systemName: "xmark") }.buttonStyle(.glass).buttonBorderShape(.circle)
            }
        }
        .padding(48)
        .frame(width: 960, height: 600, alignment: .topLeading)
    }
}

func pump(_ seconds: TimeInterval) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
}

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "glass-reference")
try FileManager.default.createDirectory(at: out.appendingPathComponent("scenes"), withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: out.appendingPathComponent("apple"), withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: out.appendingPathComponent("bare"), withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: out.appendingPathComponent("controls"), withIntermediateDirectories: true)

let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.finishLaunching()

let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: 80, y: 80), size: canvas),
                      styleMask: [.borderless], backing: .buffered, defer: false)
window.isOpaque = true
window.colorSpace = .sRGB
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
    window.appearance = NSAppearance(named: .aqua)
    pump(0.4)
    capture(window, to: out.appendingPathComponent("bare/\(scene).png"))
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
                capture(window, to: out.appendingPathComponent("apple/\(name).png"))
                cases.append([
                    "name": name, "scene": scene, "style": styleName,
                    "appearance": appearanceName, "tint": tintName,
                ])
                views.forEach { $0.removeFromSuperview() }
            }
        }
    }
}

var controlCases: [String] = []
for scene in ["blobs", "white", "darktext"] {
    backdrop.image = NSImage(cgImage: renderScene(scene, scale: scale), size: canvas)
    for (appearanceName, appearance) in appearances {
        window.appearance = NSAppearance(named: appearance)
        let host = NSHostingView(rootView: ControlsPanel())
        host.frame = root.bounds
        root.addSubview(host)
        pump(0.8)
        let name = "\(scene)-\(appearanceName)"
        capture(window, to: out.appendingPathComponent("controls/\(name).png"))
        controlCases.append(name)
        host.removeFromSuperview()
    }
}

let manifest: [String: Any] = [
    "controls": controlCases,
    "canvas": [canvas.width, canvas.height],
    "scale": scale,
    "os": ProcessInfo.processInfo.operatingSystemVersionString,
    "reduceTransparency": NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency,
    "increaseContrast": NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast,
    "gpu": MTLCreateSystemDefaultDevice()?.name ?? "none",
    "shapes": shapes.map { ["name": $0.name, "rect": [$0.rect.minX, $0.rect.minY, $0.rect.width, $0.rect.height], "radius": $0.radius] },
    "tints": ["blue": [0.0, 0.533, 1.0, 0.6]],
    "cases": cases,
]
let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
try data.write(to: out.appendingPathComponent("manifest.json"))
print("wrote \(cases.count) cases to \(out.path)")
