// Sweeps Apple's glass (NSGlassEffectView) across backdrop brightness and
// pane size, so Cap's glass can match how Apple's adapts: small Regular
// panes lighten over bright content in dark mode, and tints are tone mapped
// against what is behind them. Writes <out>/scenes/<scene>.png,
// <out>/apple/<case>.png and <out>/manifest.json in the same format as
// reference.swift.
//
//   swiftc -O sweep.swift -o sweep && ./sweep <out dir> [lens | tints]
//
// `lens` swaps the greys for the UV ramp (red and green encode the sampled
// point), so the same shapes show how Apple's refraction scales with size.
// `tints` runs a grid of tint colours and alphas over three greys, to fit
// how a tint's colour and alpha set the tinted glass. `levels` runs Clear
// glass only, under tints spanning their brightest and darkest channel,
// which is what sets how a tint darkens over dark content. `hsl` runs Clear
// glass under a regular grid of HSL lightness and saturation at one hue:
// the tint keeps its hue, so this grid is the whole law.
//
// Each style and appearance keeps the same views for a rising and then a
// falling pass over the greys, so any hysteresis in the adaptation shows up
// as a difference between the `up` and `down` captures of a level.
import AppKit
import Metal

let canvas = NSSize(width: 960, height: 600)

struct Shape {
    let name: String
    let rect: NSRect
    let radius: CGFloat
}

var shapes: [Shape] = []
do {
    // Capsules of one width and rising height.
    var y: CGFloat = 20
    for height in [20, 28, 36, 44, 52, 64, 80, 96] as [CGFloat] {
        shapes.append(Shape(name: "capsule\(Int(height))", rect: NSRect(x: 30, y: y, width: 200, height: height), radius: height / 2))
        y += height + 18
    }
    // Squares with a fixed corner radius.
    y = 20
    for side in [24, 32, 48, 64, 96, 128] as [CGFloat] {
        shapes.append(Shape(name: "square\(Int(side))", rect: NSRect(x: 270, y: y, width: side, height: side), radius: min(12, side / 2)))
        y += side + 18
    }
    // Bars of one height and rising width, then a large panel.
    y = 20
    for width in [60, 120, 240, 420] as [CGFloat] {
        shapes.append(Shape(name: "bar\(Int(width))", rect: NSRect(x: 460, y: y, width: width, height: 44), radius: 22))
        y += 44 + 18
    }
    shapes.append(Shape(name: "panel", rect: NSRect(x: 460, y: 300, width: 460, height: 270), radius: 24))
}

let greys: [Int] = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255]
let styles: [(String, NSGlassEffectView.Style)] = [("regular", .regular), ("clear", .clear)]
let appearances: [(String, NSAppearance.Name)] = [("light", .aqua), ("dark", .darkAqua)]
let tints: [(String, NSColor?, [Double])] = [
    ("none", nil, []),
    ("blue", NSColor.systemBlue.withAlphaComponent(0.6), [0.0, 0.533, 1.0, 0.6]),
    ("red", NSColor.systemRed.withAlphaComponent(0.6), [1.0, 0.22, 0.235, 0.6]),
    ("green", NSColor.systemGreen.withAlphaComponent(0.6), [0.204, 0.78, 0.349, 0.6]),
    ("blue30", NSColor.systemBlue.withAlphaComponent(0.3), [0.0, 0.533, 1.0, 0.3]),
    ("blue100", NSColor.systemBlue, [0.0, 0.533, 1.0, 1.0]),
]

final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

func greyImage(_ level: Int, scale: CGFloat) -> CGImage {
    let width = Int(canvas.width * scale), height = Int(canvas.height * scale)
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let v = CGFloat(level) / 255
    ctx.setFillColor(CGColor(srgbRed: v, green: v, blue: v, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return ctx.makeImage()!
}

func uvImage(scale: CGFloat) -> CGImage {
    let width = Int(canvas.width * scale), height = Int(canvas.height * scale)
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    for row in 0..<height {
        for col in 0..<width {
            ctx.setFillColor(CGColor(srgbRed: CGFloat(col) / CGFloat(width - 1),
                                     green: CGFloat(row) / CGFloat(height - 1), blue: 0.5, alpha: 1))
            ctx.fill(CGRect(x: col, y: row, width: 1, height: 1))
        }
    }
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

func pump(_ seconds: TimeInterval) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
}

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "glass-sweep")
let lensMode = CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "lens"
let hslMode = CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "hsl"
let levelsMode = hslMode || (CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "levels")
let tintMode = levelsMode || (CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "tints")
let tintGrid: [(String, NSColor?, [Double])] = {
    var grid: [(String, NSColor?, [Double])] = [("none", nil, [])]
    func add(_ name: String, _ r: Double, _ g: Double, _ b: Double, _ a: Double) {
        grid.append((name, NSColor(srgbRed: r, green: g, blue: b, alpha: a), [r, g, b, a]))
    }
    for i in 0..<12 {
        let color = NSColor(calibratedHue: CGFloat(i) / 12, saturation: 1, brightness: 1, alpha: 1).usingColorSpace(.sRGB)!
        add("hue\(i * 30)", Double(color.redComponent), Double(color.greenComponent), Double(color.blueComponent), 0.6)
    }
    add("white", 1, 1, 1, 0.6)
    add("grey50", 0.5, 0.5, 0.5, 0.6)
    add("black", 0, 0, 0, 0.6)
    add("navy", 0.1, 0.15, 0.45, 0.6)
    add("brown", 0.55, 0.35, 0.2, 0.6)
    add("pastel", 0.95, 0.75, 0.85, 0.6)
    for a in [0.1, 0.2, 0.45, 0.8, 1.0] {
        add("orange\(Int(a * 100))", 1, 0.58, 0.0, a)
    }
    if levelsMode {
        grid = [("none", nil, [])]
        for high in [0.2, 0.4, 0.6, 0.8, 1.0] {
            for fraction in [0.0, 0.25, 0.5, 0.75] {
                let low = high * fraction
                add("warm\(Int(high * 100))-\(Int(fraction * 100))", high, low + (high - low) * 0.3, low, 0.6)
                add("cool\(Int(high * 100))-\(Int(fraction * 100))", low, low + (high - low) * 0.6, high, 0.6)
            }
            add("grey\(Int(high * 100))", high, high, high, 0.6)
        }
    }
    if hslMode {
        grid = [("none", nil, [])]
        // HSL to sRGB at hue 210 degrees: red is the darkest channel, blue
        // the brightest, green halfway between.
        for lightness in [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0] {
            for saturation in [0.0, 0.25, 0.5, 0.75, 1.0] {
                let chroma = (1 - abs(2 * lightness - 1)) * saturation
                let low = lightness - chroma / 2
                let high = lightness + chroma / 2
                add("l\(Int(lightness * 100))-s\(Int(saturation * 100))", low, (low + high) / 2, high, 0.6)
            }
        }
    }
    return grid
}()
try FileManager.default.createDirectory(at: out.appendingPathComponent("scenes"), withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: out.appendingPathComponent("apple"), withIntermediateDirectories: true)

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
let backdrop = NSImageView(frame: root.bounds)
backdrop.imageScaling = .scaleAxesIndependently
root.addSubview(backdrop)

// Scene names by level; the lens mode has one scene, the UV ramp.
var images: [Int: NSImage] = [:]
var sceneNames: [Int: String] = [:]
let levels: [Int] = lensMode ? [-1] : tintMode ? [16, 128, 240] : greys
for level in levels {
    let image = level < 0 ? uvImage(scale: scale) : greyImage(level, scale: scale)
    let scene = level < 0 ? "uv" : String(format: "grey%03d", level)
    writePNG(image, to: out.appendingPathComponent("scenes/\(scene).png"))
    images[level] = NSImage(cgImage: image, size: canvas)
    sceneNames[level] = scene
}

var cases: [[String: Any]] = []
let runTints = lensMode ? Array(tints.prefix(1)) : tintMode ? tintGrid : tints
for (tintName, tint, _) in runTints {
    for (styleName, style) in styles {
        for (appearanceName, appearance) in appearances {
            // Clear's tint does not depend on the appearance, so the grid
            // only needs Clear in light mode.
            if tintMode && styleName == "clear" && appearanceName == "dark" {
                continue
            }
            if levelsMode && styleName == "regular" {
                continue
            }
            window.appearance = NSAppearance(named: appearance)
            backdrop.image = images[levels[0]]
            var views: [NSView] = []
            for shape in shapes {
                let glass = NSGlassEffectView(frame: shape.rect)
                glass.style = style
                glass.cornerRadius = shape.radius
                glass.tintColor = tint
                root.addSubview(glass)
                views.append(glass)
            }
            pump(1.0)
            // Untinted runs go up and back down to expose hysteresis; tinted
            // ones only go up.
            let passes: [(String, [Int])] = tintName == "none" && !lensMode && !tintMode
                ? [("up", levels), ("down", levels.reversed())]
                : [("up", levels)]
            for (pass, levels) in passes {
                for level in levels {
                    backdrop.image = images[level]
                    pump(1.0)
                    let scene = sceneNames[level]!
                    let name = "\(scene)-\(styleName)-\(appearanceName)-\(tintName)-\(pass)"
                    capture(window, to: out.appendingPathComponent("apple/\(name).png"))
                    cases.append([
                        "name": name, "scene": scene, "style": styleName,
                        "appearance": appearanceName, "tint": tintName, "pass": pass,
                    ])
                }
            }
            views.forEach { $0.removeFromSuperview() }
        }
    }
}

let manifest: [String: Any] = [
    "canvas": [canvas.width, canvas.height],
    "scale": scale,
    "os": ProcessInfo.processInfo.operatingSystemVersionString,
    "reduceTransparency": NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency,
    "increaseContrast": NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast,
    "gpu": MTLCreateSystemDefaultDevice()?.name ?? "none",
    "shapes": shapes.map { ["name": $0.name, "rect": [$0.rect.minX, $0.rect.minY, $0.rect.width, $0.rect.height], "radius": $0.radius] },
    "tints": Dictionary(uniqueKeysWithValues: runTints.filter { !$0.2.isEmpty }.map { ($0.0, $0.2) }),
    "cases": cases,
]
let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
try data.write(to: out.appendingPathComponent("manifest.json"))
print("wrote \(cases.count) cases to \(out.path)")
