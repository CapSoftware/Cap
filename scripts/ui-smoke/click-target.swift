// A plain window under everything else that appends each click it receives to
// the file named by its first argument, as "x y" in top-left screen points.
import AppKit

final class Recorder: NSView {
    let output: FileHandle
    init(frame: NSRect, output: FileHandle) {
        self.output = output
        super.init(frame: frame)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        let point = NSEvent.mouseLocation
        let height = NSScreen.screens[0].frame.height
        output.write("\(Int(point.x)) \(Int(height - point.y))\n".data(using: .utf8)!)
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedRed: 0.85, green: 0.92, blue: 1, alpha: 1).setFill()
        dirtyRect.fill()
    }
}

let path = CommandLine.arguments[1]
FileManager.default.createFile(atPath: path, contents: nil)
let output = FileHandle(forWritingAtPath: path)!
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let frame = NSScreen.screens[0].frame
let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = Recorder(frame: frame, output: output)
window.title = "Click target"
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
