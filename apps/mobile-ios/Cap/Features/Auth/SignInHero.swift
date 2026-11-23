import SwiftUI

struct SignInHero: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @State private var start = Date.now
    @State private var finished = false

    var body: some View {
        GeometryReader { proxy in
            TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion || finished)) { context in
                let time = reduceMotion || finished ? SignInScene.end : context.date.timeIntervalSince(start)
                let scene = SignInScene(size: proxy.size, time: time, dark: colorScheme == .dark)
                ZStack(alignment: .topLeading) {
                    let word = scene.wordmarkFrame
                    Image("CapWordmark")
                        .resizable()
                        .interpolation(.high)
                        .frame(width: word.width, height: word.height)
                        .mask {
                            Canvas { context, size in scene.drawWordmarkMask(in: &context, size: size) }
                        }
                        .offset(x: word.minX, y: word.minY)
                    let logo = scene.logoFrame
                    Image("CapLogoLarge")
                        .resizable()
                        .interpolation(.high)
                        .frame(width: logo.width, height: logo.height)
                        .scaleEffect(scene.logoScale)
                        .shadow(color: Color(red: 0.1, green: 0.27, blue: 0.75).opacity(0.18 * scene.logoOpacity), radius: logo.width * 0.12, y: logo.width * 0.05)
                        .opacity(scene.logoOpacity)
                        .offset(x: logo.minX, y: logo.minY)
                    if let pixels = scene.pixels() {
                        Image(decorative: pixels, scale: 1)
                            .interpolation(.none)
                            .resizable()
                            .frame(width: scene.gridSize.width, height: scene.gridSize.height)
                            .offset(scene.origin)
                    }
                    Canvas { context, _ in scene.drawInk(in: &context) }
                }
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
            }
        }
        .accessibilityHidden(true)
        .task {
            guard !reduceMotion else { return }
            try? await Task.sleep(for: .seconds(SignInScene.end + 0.1))
            finished = true
        }
    }
}

struct SignInScene {
    /// Reduce Motion shows only this moment.
    static let end: Double = 3.9
    static let cell: CGFloat = 3.5

    private enum Beat {
        static let cursorIn = 0.0...0.4
        static let drag = 0.4...1.15
        static let cursorOut = 1.15...1.7
        static let develop = 1.0...2.0
        static let resolve = 2.0...2.7
        static let inkOut = 2.6...3.0
        static let lockup = 2.75...3.5
        static let wordmark = 3.05...3.75
    }

    let size: CGSize
    let time: Double
    let dark: Bool

    let cols: Int
    let rows: Int
    private let selection: CGRect
    /// The glass logo is a 40-unit tile, so its rings sit at 16, 13 and 10 of 20.
    private var tileHalf: CGFloat { selection.width * 0.39 }

    init(size: CGSize, time: Double, dark: Bool) {
        self.size = size
        self.time = time
        self.dark = dark
        cols = max(1, Int(size.width / Self.cell))
        rows = max(1, Int(size.height / Self.cell))
        let side = min(CGFloat(rows) * 0.78, CGFloat(cols) * 0.5).rounded()
        selection = CGRect(x: (CGFloat(cols) - side) / 2, y: (CGFloat(rows) - side) / 2, width: side, height: side)
    }

    var gridSize: CGSize { CGSize(width: CGFloat(cols) * Self.cell, height: CGFloat(rows) * Self.cell) }
    var origin: CGSize { CGSize(width: (size.width - gridSize.width) / 2, height: (size.height - gridSize.height) / 2) }

    /// The full logo is the 40-unit mark, then the wordmark from 44 to 104; its ink ends near 100.5, so that's what's centred.
    private var lockupUnit: CGFloat { min(72, size.height * 0.42, size.width * 0.2) / 40 }
    private var lockupOrigin: CGPoint {
        CGPoint(x: size.width / 2 - 50.25 * lockupUnit, y: size.height / 2 - 20 * lockupUnit)
    }

    /// Its tile is 39.5 of 40 units.
    var logoFrame: CGRect {
        let side = tileHalf * 2 * Self.cell * 40 / 39.5
        let center = point(selection.midX, selection.midY)
        let large = CGRect(x: center.x - side / 2, y: center.y - side / 2, width: side, height: side)
        let small = CGRect(origin: lockupOrigin, size: CGSize(width: 40 * lockupUnit, height: 40 * lockupUnit))
        let t = CGFloat(progress(Beat.lockup, ease: true))
        return CGRect(
            x: large.minX + (small.minX - large.minX) * t,
            y: large.minY + (small.minY - large.minY) * t,
            width: large.width + (small.width - large.width) * t,
            height: large.height + (small.height - large.height) * t
        )
    }

    var wordmarkFrame: CGRect {
        CGRect(x: lockupOrigin.x + 44 * lockupUnit, y: lockupOrigin.y, width: 60 * lockupUnit, height: 40 * lockupUnit)
    }

    func drawWordmarkMask(in context: inout GraphicsContext, size: CGSize) {
        let shown = progress(Beat.wordmark)
        guard shown > 0 else { return }
        guard shown < 1 else {
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.black))
            return
        }
        let cell = Self.cell * 0.75
        let columns = Int((size.width / cell).rounded(.up))
        let lines = Int((size.height / cell).rounded(.up))
        var path = Path()
        for column in 0..<columns {
            let along = Double(column) / Double(max(1, columns - 1))
            let reveal = clamp((shown * 1.35 - along) * 4)
            guard reveal > 0 else { continue }
            for line in 0..<lines where Self.threshold(column, line) < reveal {
                path.addRect(CGRect(x: CGFloat(column) * cell, y: CGFloat(line) * cell, width: cell, height: cell))
            }
        }
        context.fill(path, with: .color(.black))
    }

    /// Fully there early in the resolve, so the gaps the pixels leave show it, not the background.
    var logoOpacity: Double { progress(Beat.resolve.lowerBound...(Beat.resolve.lowerBound + 0.2), ease: true) }
    var logoScale: Double { 1.04 - 0.04 * progress(Beat.resolve, ease: true) }

    private func point(_ cellX: CGFloat, _ cellY: CGFloat) -> CGPoint {
        CGPoint(x: origin.width + cellX * Self.cell, y: origin.height + cellY * Self.cell)
    }

    // MARK: Pixels

    /// Index 0 is no ink.
    private static let blues: [(UInt8, UInt8, UInt8)] = [
        (0, 0, 0), (0x1E, 0x3A, 0x8A), (0x2F, 0x63, 0xF0), (0x47, 0x85, 0xFF), (0xAD, 0xC9, 0xFF), (0xDC, 0xE7, 0xFF), (0xFF, 0xFF, 0xFF),
    ]

    private static let bayer: [Double] = [
        0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
        28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47,
        7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
    ].map { ($0 + 0.5) / 64 }

    private static func threshold(_ x: Int, _ y: Int) -> Double { bayer[((y & 7) << 3) | (x & 7)] }

    func pixels() -> CGImage? {
        let developed = progress(Beat.develop)
        let resolved = progress(Beat.resolve)
        guard developed > 0, resolved < 1 else { return nil }
        let cx = Double(selection.midX)
        let cy = Double(selection.midY)
        let half = Double(tileHalf)
        let corner = 7.75 / 20
        let sweep = time * 2.2 - 1.2
        var bytes = [UInt8](repeating: 0, count: cols * rows * 4)

        for y in 0..<rows {
            for x in 0..<cols {
                let threshold = Self.threshold(x, y)
                var color: (UInt8, UInt8, UInt8)?

                if threshold >= resolved {
                    let u = (Double(x) + 0.5 - cx) / half
                    let v = (Double(y) + 0.5 - cy) / half
                    let qx = abs(u) - (1 - corner)
                    let qy = abs(v) - (1 - corner)
                    let edge = (max(qx, 0) * max(qx, 0) + max(qy, 0) * max(qy, 0)).squareRoot() + min(max(qx, qy), 0) - corner
                    if edge < 0.3 {
                        let d = (u * u + v * v).squareRoot()
                        let reveal = clamp((developed * 1.9 - d * 0.5) * 2.2)
                        if threshold < reveal {
                            let shade = (u + v) * 0.25
                            var delta = abs(remainder(atan2(v, u) - sweep, 2 * .pi))
                            delta *= delta
                            let light = exp(-delta / 0.2) * developed
                            var value: Double
                            if d < 0.5 {
                                value = 6.2 - shade
                            } else if d < 0.65 {
                                value = 4.4 - shade + light * 0.8
                            } else if d < 0.8 {
                                value = 3.35 - shade - max(0, d - 0.76) * 8 + light * 1.4
                            } else if edge < -0.07 {
                                value = (dark ? 6.2 : 5.75) - max(0, edge + 0.25) * 4
                            } else if edge < 0 {
                                value = 4.3
                            } else {
                                let fall = 1 - edge / 0.3
                                if threshold < 0.6 * fall * fall * reveal {
                                    color = Self.blues[dark ? 2 : 4]
                                }
                                value = -1
                            }
                            if value >= 0 {
                                value += (1 - reveal) * 1.6
                                let index = min(Self.blues.count - 1, Int(value + threshold))
                                if index > 0 { color = Self.blues[index] }
                            }
                        }
                    }
                }

                if let color {
                    let offset = (y * cols + x) * 4
                    bytes[offset] = color.0
                    bytes[offset + 1] = color.1
                    bytes[offset + 2] = color.2
                    bytes[offset + 3] = 255
                }
            }
        }

        guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
        return CGImage(
            width: cols,
            height: rows,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: cols * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        )
    }

    // MARK: Ink

    private var ink: Color { dark ? Color(white: 0.94) : Color(white: 0.1) }
    private var paper: Color { dark ? .black : .white }
    private var boil: Int { Int(time / 0.15) % 3 }

    func drawInk(in context: inout GraphicsContext) {
        context.opacity = 1 - progress(Beat.inkOut, ease: true)
        guard context.opacity > 0 else { return }
        let corner = point(selection.minX, selection.minY)
        let far = point(selection.maxX, selection.maxY)
        let cursor = cursorPosition(from: corner, to: far)
        let dragged = progress(Beat.drag, ease: true)

        if dragged > 0 {
            let end = CGPoint(x: corner.x + (far.x - corner.x) * dragged, y: corner.y + (far.y - corner.y) * dragged)
            let frame = sketchRect(from: corner, to: end, seed: boil)
            context.stroke(frame, with: .color(ink.opacity(0.75)), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round, dash: [7, 6], dashPhase: -time * 14))

            let handles = progress(1.1...1.4)
            if handles > 0 {
                for (index, handle) in [corner, CGPoint(x: far.x, y: corner.y), CGPoint(x: corner.x, y: far.y), far].enumerated() {
                    let circle = sketchCircle(at: handle, radius: 4.2 * handles, seed: boil + index)
                    context.fill(circle, with: .color(paper))
                    context.stroke(circle, with: .color(ink), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                }
            }
        }

        let shown = progress(Beat.cursorIn)
        guard shown > 0 else { return }
        var cursorContext = context
        cursorContext.opacity = context.opacity * shown
        let arrow = sketchCursor(at: cursor, seed: boil)
        cursorContext.fill(arrow, with: .color(paper))
        cursorContext.stroke(arrow, with: .color(ink), style: StrokeStyle(lineWidth: 1.7, lineCap: .round, lineJoin: .round))
    }

    private func cursorPosition(from corner: CGPoint, to far: CGPoint) -> CGPoint {
        let span = far.x - corner.x
        let entry = CGPoint(x: corner.x - span * 0.55, y: corner.y + span * 0.35)
        let rest = CGPoint(x: far.x + span * 0.12, y: far.y + span * 0.05)
        if time < Beat.drag.lowerBound {
            return mix(entry, corner, progress(Beat.cursorIn, ease: true))
        }
        if time < Beat.drag.upperBound {
            return mix(corner, far, progress(Beat.drag, ease: true))
        }
        let away = mix(far, rest, progress(Beat.cursorOut, ease: true))
        let bob = time > Beat.cursorOut.upperBound ? sin((time - Beat.cursorOut.upperBound) * 2.2) * 2.5 : 0
        return CGPoint(x: away.x, y: away.y + bob)
    }

    // MARK: Sketching

    private func wobble(_ seed: Int, _ index: Int) -> CGFloat {
        CGFloat(Self.hash(seed &* 7919 &+ index &* 104_729)) - 0.5
    }

    private func sketchRect(from a: CGPoint, to b: CGPoint, seed: Int) -> Path {
        let corners = [a, CGPoint(x: b.x, y: a.y), b, CGPoint(x: a.x, y: b.y), a]
        var path = Path()
        var index = 0
        for side in 0..<4 {
            let start = corners[side]
            let end = corners[side + 1]
            let length = hypot(end.x - start.x, end.y - start.y)
            let steps = max(2, Int(length / 9))
            let normal = length > 0 ? CGPoint(x: -(end.y - start.y) / length, y: (end.x - start.x) / length) : .zero
            for step in 0...steps {
                let t = CGFloat(step) / CGFloat(steps)
                let bow = sin(t * .pi) * length * 0.012
                let jitter = wobble(seed, index) * 1.6
                let p = CGPoint(x: start.x + (end.x - start.x) * t + normal.x * (bow + jitter), y: start.y + (end.y - start.y) * t + normal.y * (bow + jitter))
                if side == 0, step == 0 { path.move(to: p) } else { path.addLine(to: p) }
                index += 1
            }
        }
        return path
    }

    private func sketchCircle(at center: CGPoint, radius: CGFloat, seed: Int) -> Path {
        var path = Path()
        let steps = 14
        for step in 0...steps {
            let angle = CGFloat(step) / CGFloat(steps) * 2 * .pi
            let r = radius + wobble(seed, step % steps) * 0.9
            let p = CGPoint(x: center.x + cos(angle) * r, y: center.y + sin(angle) * r)
            if step == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        path.closeSubpath()
        return path
    }

    private func sketchCursor(at tip: CGPoint, seed: Int) -> Path {
        let shape: [CGPoint] = [(0, 0), (0, 18), (4.6, 13.8), (7.8, 21), (10.6, 19.8), (7.5, 12.8), (13.2, 12.8)].map { CGPoint(x: $0.0, y: $0.1) }
        let scale: CGFloat = 1.35
        var path = Path()
        for (index, point) in shape.enumerated() {
            let p = CGPoint(x: tip.x + point.x * scale + wobble(seed, index) * 1.1, y: tip.y + point.y * scale + wobble(seed, index + 40) * 1.1)
            if index == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        path.closeSubpath()
        return path
    }

    // MARK: Timing

    private func progress(_ range: ClosedRange<Double>, ease: Bool = false) -> Double {
        let t = clamp((time - range.lowerBound) / (range.upperBound - range.lowerBound))
        return ease ? t * t * (3 - 2 * t) : t
    }

    private func clamp(_ value: Double) -> Double { min(1, max(0, value)) }

    private func mix(_ a: CGPoint, _ b: CGPoint, _ t: Double) -> CGPoint {
        CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
    }

    private static func hash(_ n: Int) -> Double {
        var h = UInt32(truncatingIfNeeded: n) &* 0x27D4_EB2D ^ 0x1656_67B1
        h = (h ^ (h >> 15)) &* 0x85EB_CA6B
        h = (h ^ (h >> 13)) &* 0xC2B2_AE35
        return Double(h ^ (h >> 16)) / 4_294_967_296
    }
}
