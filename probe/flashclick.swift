import AVFoundation
import AppKit

// flashclick <seconds> [interval]
// Full-screen black window that flashes white and plays a click on the
// default output at the same instant every <interval> seconds.

let args = CommandLine.arguments
let duration = args.count > 1 ? Double(args[1]) ?? 60 : 60
let interval = args.count > 2 ? Double(args[2]) ?? 2 : 2

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let screen = NSScreen.main!
let window = NSWindow(
    contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
window.level = .statusBar
window.backgroundColor = .black
window.isOpaque = true
window.ignoresMouseEvents = true
window.collectionBehavior = [.canJoinAllSpaces, .stationary]
window.makeKeyAndOrderFront(nil)
window.orderFrontRegardless()

let engine = AVAudioEngine()
let player = AVAudioPlayerNode()
let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
engine.attach(player)
engine.connect(player, to: engine.mainMixerNode, format: format)
let frames = AVAudioFrameCount(48_000 * 0.03)
let click = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
click.frameLength = frames
for channel in 0..<2 {
    let data = click.floatChannelData![channel]
    for i in 0..<Int(frames) {
        let t = Double(i) / 48_000
        data[i] = Float(0.8 * sin(2 * Double.pi * 1_000 * t) * exp(-t * 120))
    }
}
try! engine.start()
player.play()

let start = Date()
var flashes = 0
Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { timer in
    if Date().timeIntervalSince(start) > duration {
        timer.invalidate()
        print("flashes \(flashes)")
        exit(0)
    }
    flashes += 1
    window.backgroundColor = .white
    window.display()
    player.scheduleBuffer(click, at: nil, options: [], completionHandler: nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        window.backgroundColor = .black
        window.display()
    }
}
app.run()
