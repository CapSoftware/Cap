// Captures macOS's own controls, in a key window, as the reference for Cap's
// app-wide glass styling: every standard control, a sidebar window, a grouped
// settings form and an open pop-up menu, in light and dark.
//
//   swiftc -O gallery.swift -o gallery && ./gallery <out dir>
//
// Needs Screen Recording for the process that runs it.

import AppKit
import SwiftUI

let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "gallery")
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

struct Controls: View {
    @State var on = true
    @State var off = false
    @State var check = true
    @State var level = 0.4
    @State var segment = 1
    @State var choice = "Studio"
    @State var text = "My recording"
    @State var search = ""
    @State var radio = 0
    @State var stepper = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 14) {
                Button("Glass") {}.buttonStyle(.glass)
                Button("Prominent") {}.buttonStyle(.glassProminent)
                Button("Bordered") {}.buttonStyle(.bordered)
                Button("Bordered Prominent") {}.buttonStyle(.borderedProminent)
                Button("Plain") {}.buttonStyle(.plain)
                Button("Disabled") {}.buttonStyle(.glass).disabled(true)
            }
            HStack(spacing: 14) {
                Button("Small") {}.buttonStyle(.glass).controlSize(.small)
                Button("Regular") {}.buttonStyle(.glass)
                Button("Large") {}.buttonStyle(.glass).controlSize(.large)
                Button("Extra Large") {}.buttonStyle(.glassProminent).controlSize(.extraLarge)
                Button {} label: { Image(systemName: "xmark") }.buttonStyle(.glass).buttonBorderShape(.circle)
                Button {} label: { Image(systemName: "gearshape") }.buttonStyle(.glass).buttonBorderShape(.circle).controlSize(.large)
                Button {} label: { Label("Record", systemImage: "record.circle") }.buttonStyle(.glassProminent).tint(.red)
            }
            HStack(spacing: 18) {
                Picker("Mode", selection: $choice) {
                    Text("Instant").tag("Instant")
                    Text("Studio").tag("Studio")
                    Text("Screenshot").tag("Screenshot")
                }
                .pickerStyle(.menu)
                .frame(width: 180)
                Picker("", selection: $segment) {
                    Text("Free").tag(0)
                    Text("16:9").tag(1)
                    Text("4:3").tag(2)
                    Text("1:1").tag(3)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 220)
                Menu("Options") {
                    Button("Rename") {}
                    Button("Duplicate") {}
                }
                .frame(width: 110)
            }
            HStack(spacing: 18) {
                Toggle("", isOn: $on).toggleStyle(.switch).labelsHidden()
                Toggle("", isOn: $off).toggleStyle(.switch).labelsHidden()
                Toggle("Checkbox", isOn: $check).toggleStyle(.checkbox)
                Picker("", selection: $radio) {
                    Text("One").tag(0)
                    Text("Two").tag(1)
                }
                .pickerStyle(.radioGroup)
                .horizontalRadioGroupLayout()
                .labelsHidden()
                Stepper("Count \(stepper)", value: $stepper)
                Slider(value: $level).frame(width: 220)
            }
            HStack(spacing: 18) {
                TextField("Title", text: $text).textFieldStyle(.roundedBorder).frame(width: 220)
                TextField("Search", text: $search).textFieldStyle(.roundedBorder).frame(width: 180)
                ProgressView(value: 0.6).frame(width: 160)
                ProgressView().controlSize(.small)
            }
            GroupBox("Group box") {
                Text("Content inside a group box").frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(width: 420)
        }
        .padding(28)
    }
}

struct Sidebar: View {
    @State var selection: String? = "Recordings"
    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section("Library") {
                    Label("Recordings", systemImage: "film").tag("Recordings")
                    Label("Screenshots", systemImage: "camera").tag("Screenshots")
                    Label("Shared", systemImage: "link").tag("Shared")
                }
                Section("Settings") {
                    Label("General", systemImage: "gearshape").tag("General")
                    Label("Shortcuts", systemImage: "keyboard").tag("Shortcuts")
                }
            }
            .navigationSplitViewColumnWidth(200)
        } detail: {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 16)], spacing: 16) {
                    ForEach(0..<6) { index in
                        VStack(alignment: .leading, spacing: 6) {
                            RoundedRectangle(cornerRadius: 10)
                                .fill(Color(hue: Double(index) / 6, saturation: 0.35, brightness: 0.85))
                                .aspectRatio(16 / 10, contentMode: .fit)
                            Text("Recording \(index + 1)").font(.headline)
                            Text("2 min · Today").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(20)
            }
            .toolbar {
                ToolbarItem { Button {} label: { Image(systemName: "plus") } }
                ToolbarItem { Button {} label: { Image(systemName: "square.and.arrow.up") } }
                ToolbarItem { Picker("", selection: .constant(0)) { Image(systemName: "square.grid.2x2").tag(0); Image(systemName: "list.bullet").tag(1) }.pickerStyle(.segmented) }
            }
            .navigationTitle("Recordings")
        }
    }
}

struct Settings: View {
    @State var launch = true
    @State var sound = false
    @State var quality = "High"
    @State var countdown = 3.0
    var body: some View {
        Form {
            Section("General") {
                Toggle("Open at login", isOn: $launch)
                Toggle("Play sounds", isOn: $sound)
                Picker("Export quality", selection: $quality) {
                    Text("High").tag("High")
                    Text("Medium").tag("Medium")
                }
            }
            Section("Recording") {
                Slider(value: $countdown, in: 0...10) { Text("Countdown") }
                LabeledContent("Folder") { Button("Choose…") {} }
            }
        }
        .formStyle(.grouped)
    }
}

func window<V: View>(_ title: String, _ view: V, size: NSSize, toolbar: Bool = false) -> NSWindow {
    let window = NSWindow(
        contentRect: NSRect(origin: NSPoint(x: 120, y: 120), size: size),
        styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
        backing: .buffered, defer: false)
    window.title = title
    window.contentView = NSHostingView(rootView: view)
    if toolbar { window.toolbar = NSToolbar() }
    window.isReleasedWhenClosed = false
    return window
}

func pump(_ seconds: TimeInterval) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
}

func capture(_ window: NSWindow, _ name: String) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    task.arguments = ["-x", "-o", "-l\(window.windowNumber)", out.appendingPathComponent("\(name).png").path]
    try? task.run()
    task.waitUntilExit()
}

func captureScreen(_ name: String) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    task.arguments = ["-x", out.appendingPathComponent("\(name).png").path]
    try? task.run()
    task.waitUntilExit()
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.finishLaunching()
app.activate(ignoringOtherApps: true)
pump(2)

for (appearance, suffix) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
    app.appearance = NSAppearance(named: appearance)
    for (name, w) in [
        ("controls", window("Controls", Controls(), size: NSSize(width: 980, height: 430))),
        ("sidebar", window("Recordings", Sidebar(), size: NSSize(width: 900, height: 560))),
        ("settings", window("Settings", Settings(), size: NSSize(width: 560, height: 460))),
    ] {
        w.center()
        w.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        pump(2.5)
        capture(w, "\(name)-\(suffix)")
        if name == "controls" {
            // An open menu: a pop-up NSMenu over the window, captured with the screen.
            let menu = NSMenu()
            menu.autoenablesItems = false
            for title in ["Instant", "Studio", "Screenshot"] { menu.addItem(withTitle: title, action: nil, keyEquivalent: "") }
            menu.addItem(.separator())
            menu.addItem(withTitle: "Recording settings…", action: nil, keyEquivalent: ",")
            menu.items[1].state = .on
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                captureScreen("menu-\(suffix)")
                menu.cancelTracking()
            }
            menu.popUp(positioning: menu.items[1], at: NSPoint(x: 60, y: 300), in: w.contentView)
            pump(0.5)
        }
        w.orderOut(nil)
    }
}
print("wrote \(out.path)")
