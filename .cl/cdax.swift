// cdax: what VoiceOver can see of one process (macOS Accessibility), and real key presses.
//   cdax trusted                 whether this process may use Accessibility
//   cdax tree <pid>              every element: depth role | title | description | value | flags
//                                (F focusable or pressable, * focused), then a count line
//   cdax focus <pid>             the focused element of that app
//   cdax key <tab|shift-tab|escape|return|space>   one real key press (CGEvent, HID tap)
//   cdax windows <pid>           the app's windows: title | x,y,w,h
import ApplicationServices
import AppKit
import Foundation

func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(e, name as CFString, &value) == .success else { return nil }
    return value
}
func str(_ e: AXUIElement, _ name: String) -> String {
    guard let v = attr(e, name) else { return "" }
    if let s = v as? String { return s.replacingOccurrences(of: "\n", with: " ") }
    if CFGetTypeID(v) == AXValueGetTypeID() { return "" }
    return "\(v)"
}
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func actions(_ e: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(e, &names) == .success, let list = names as? [String] else { return [] }
    return list
}
func frame(_ e: AXUIElement) -> String {
    guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute) else { return "" }
    var point = CGPoint.zero, size = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &point)
    AXValueGetValue(s as! AXValue, .cgSize, &size)
    return "\(Int(point.x)),\(Int(point.y)),\(Int(size.width)),\(Int(size.height))"
}
func describe(_ e: AXUIElement) -> String {
    var flags = ""
    if actions(e).contains(kAXPressAction as String) { flags += "F" }
    if (attr(e, kAXFocusedAttribute) as? Bool) == true { flags += "*" }
    let value = String(str(e, kAXValueAttribute).prefix(80))
    return "\(str(e, kAXRoleAttribute))/\(str(e, kAXSubroleAttribute)) | \(String(str(e, kAXTitleAttribute).prefix(100))) | \(String(str(e, kAXDescriptionAttribute).prefix(100))) | \(value) | \(flags) | \(frame(e))"
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "trusted":
    print(AXIsProcessTrusted())
case "tree":
    let app = AXUIElementCreateApplication(pid_t(args[2])!)
    var nodes = 0, named = 0, pressable = 0
    func walk(_ e: AXUIElement, _ depth: Int) {
        guard depth < 60 else { return }
        nodes += 1
        let d = describe(e)
        if !(str(e, kAXTitleAttribute) + str(e, kAXDescriptionAttribute) + str(e, kAXValueAttribute)).isEmpty { named += 1 }
        if actions(e).contains(kAXPressAction as String) { pressable += 1 }
        print(String(repeating: "  ", count: depth) + d)
        for c in children(e) { walk(c, depth + 1) }
    }
    walk(app, 0)
    print("# nodes=\(nodes) named=\(named) pressable=\(pressable)")
case "focus":
    let app = AXUIElementCreateApplication(pid_t(args[2])!)
    if let f = attr(app, kAXFocusedUIElementAttribute) { print(describe(f as! AXUIElement)) } else { print("(nothing focused)") }
case "key":
    let codes: [String: (CGKeyCode, CGEventFlags)] = [
        "tab": (48, []), "shift-tab": (48, .maskShift), "escape": (53, []), "return": (36, []), "space": (49, []),
    ]
    guard let (code, flags) = codes[args[2]] else { print("unknown key"); exit(2) }
    let src = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] {
        let ev = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)!
        ev.flags = flags
        ev.post(tap: .cghidEventTap)
        usleep(30_000)
    }
case "front":
    // Activates the app, then prints the frontmost app's pid (callers press keys only when it matches).
    let target = pid_t(args[2])!
    if let app = NSRunningApplication(processIdentifier: target) {
        app.activate(options: [.activateAllWindows])
    }
    usleep(500_000)
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != target {
        // A background tool may not activate another app; Accessibility can.
        let ax = AXUIElementCreateApplication(target)
        AXUIElementSetAttributeValue(ax, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        usleep(500_000)
    }
    print(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)
case "attrs":
    // cdax attrs <pid> <name>: every element whose title, description or value is <name>, with what
    // VoiceOver reads from it: role/subrole | role description | title | description | value |
    // selected | help | actions. Also: whether a lookup by description alone or by value alone finds it.
    let app = AXUIElementCreateApplication(pid_t(args[2])!)
    let want = args[3]
    var found = 0
    func visit(_ e: AXUIElement, _ depth: Int) {
        guard depth < 60 else { return }
        let t = str(e, kAXTitleAttribute), d = str(e, kAXDescriptionAttribute), v = str(e, kAXValueAttribute)
        if t == want || d == want || v == want {
            found += 1
            var sel = "-"
            if let b = attr(e, kAXSelectedAttribute) as? Bool { sel = b ? "selected" : "not-selected" }
            print("\(str(e, kAXRoleAttribute))/\(str(e, kAXSubroleAttribute)) | rd=\(str(e, kAXRoleDescriptionAttribute)) | title=\(t) | desc=\(d) | value=\(v) | \(sel) | help=\(str(e, kAXHelpAttribute)) | actions=\(actions(e).joined(separator: ","))")
            print("   by-title=\(t == want) by-description=\(d == want) by-value=\(v == want)")
        }
        for c in children(e) { visit(c, depth + 1) }
    }
    visit(app, 0)
    if found == 0 { print("none named \(want)") }
case "cgwin":
    // cdax cgwin <pid>: x,y,w,h of the app's largest on-screen window from the window server (no
    // Accessibility call, so the app's tree stays off).
    let want = Int(args[2])!
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    var best: CGRect? = nil
    for w in list where (w[kCGWindowOwnerPID as String] as? Int) == want && (w[kCGWindowLayer as String] as? Int) == 0 {
        if let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b as CFDictionary),
           r.width * r.height > (best.map { $0.width * $0.height } ?? 0) { best = r }
    }
    if let r = best { print("\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width)),\(Int(r.height))") } else { exit(1) }
case "windows":
    let app = AXUIElementCreateApplication(pid_t(args[2])!)
    for w in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { print("\(str(w, kAXTitleAttribute)) | \(frame(w))") }
case "press":
    // cdax press <pid> <title or description>: AXPress on the first element with that name (what
    // VoiceOver does on VO-Space), then counts the menus the app shows.
    // A trailing "*" matches by prefix; CD_WINDOW limits the search to the window with that title.
    let app = AXUIElementCreateApplication(pid_t(args[2])!)
    let raw = args[3]
    let prefix = raw.hasSuffix("*")
    let want = prefix ? String(raw.dropLast()) : raw
    let onlyWindow = ProcessInfo.processInfo.environment["CD_WINDOW"]
    let within = ProcessInfo.processInfo.environment["CL_WITHIN"]
    func matches(_ s: String) -> Bool { prefix ? s.hasPrefix(want) : s == want }
    func find(_ e: AXUIElement, _ depth: Int, _ insideIn: Bool = false) -> AXUIElement? {
        guard depth < 60 else { return nil }
        if let only = onlyWindow, str(e, kAXRoleAttribute) == "AXWindow", str(e, kAXTitleAttribute) != only { return nil }
        let inside = insideIn || within == nil || str(e, kAXTitleAttribute) == within! || str(e, kAXDescriptionAttribute) == within!
        if inside, (matches(str(e, kAXTitleAttribute)) || matches(str(e, kAXDescriptionAttribute))),
           actions(e).contains(kAXPressAction as String) { return e }
        for c in children(e) { if let f = find(c, depth + 1, inside) { return f } }
        return nil
    }
    func menus(_ e: AXUIElement, _ depth: Int) -> [String] {
        guard depth < 60 else { return [] }
        let role = str(e, kAXRoleAttribute)
        var out: [String] = (role == "AXMenu" || role == "AXMenuItem") && depth > 2 ? [describe(e)] : []
        for c in children(e) where str(c, kAXRoleAttribute) != "AXMenuBar" { out += menus(c, depth + 1) }
        return out
    }
    let before = menus(app, 0).count
    guard let el = find(app, 0) else { print("no pressable element named \(want)"); exit(1) }
    print("pressing \(describe(el))")
    print("AXPress returned \(AXUIElementPerformAction(el, kAXPressAction as CFString).rawValue)")
    usleep(2_000_000)
    let after = menus(app, 0)
    print("menus and menu items before: \(before) after: \(after.count)")
    for m in after.prefix(8) { print("  \(m)") }
case "state":
    // cdax state <pid> <title or description>: what VoiceOver reads about the first element with that
    // name (trailing "*" = prefix; CD_WINDOW limits the window): role | name | AXSelected | AXHelp
    // (AccessKit's description) | actions.
    let app = AXUIElementCreateApplication(pid_t(args[2])!)
    let raw = args[3]
    let prefix = raw.hasSuffix("*")
    let want = prefix ? String(raw.dropLast()) : raw
    let onlyWindow = ProcessInfo.processInfo.environment["CD_WINDOW"]
    func matches(_ s: String) -> Bool { prefix ? s.hasPrefix(want) : s == want }
    func find(_ e: AXUIElement, _ depth: Int) -> AXUIElement? {
        guard depth < 60 else { return nil }
        if let only = onlyWindow, str(e, kAXRoleAttribute) == "AXWindow", str(e, kAXTitleAttribute) != only { return nil }
        if matches(str(e, kAXTitleAttribute)) || matches(str(e, kAXDescriptionAttribute)) { return e }
        for c in children(e) { if let f = find(c, depth + 1) { return f } }
        return nil
    }
    guard let el = find(app, 0) else { print("none | \(want) | - | - | -"); exit(1) }
    let name = str(el, kAXTitleAttribute).isEmpty ? str(el, kAXDescriptionAttribute) : str(el, kAXTitleAttribute)
    var selected = "not-selectable"
    if let s = attr(el, kAXSelectedAttribute) as? Bool { selected = s ? "selected" : "not-selected" }
    print("\(str(el, kAXRoleAttribute)) | \(name) | \(selected) | \(str(el, kAXHelpAttribute)) | \(actions(el).joined(separator: ","))")
case "observe":
    // cdax observe <pid> <seconds>: counts the accessibility notifications the app posts (created,
    // destroyed, layout and value changes...): what VoiceOver is told about the tree changing.
    let pid = pid_t(args[2])!
    let seconds = Double(args[3]) ?? 60
    var observer: AXObserver?
    final class Counts { var n: [String: Int] = [:] }
    let counts = Counts()
    let callback: AXObserverCallback = { _, _, note, refcon in
        let c = Unmanaged<Counts>.fromOpaque(refcon!).takeUnretainedValue()
        c.n[note as String, default: 0] += 1
    }
    guard AXObserverCreate(pid, callback, &observer) == .success, let obs = observer else { print("observer failed"); exit(1) }
    let app = AXUIElementCreateApplication(pid)
    let notes = [kAXCreatedNotification, kAXUIElementDestroyedNotification, kAXLayoutChangedNotification,
                 kAXValueChangedNotification, kAXTitleChangedNotification, kAXFocusedUIElementChangedNotification,
                 kAXSelectedChildrenChangedNotification, kAXRowCountChangedNotification, "AXAnnouncementRequested"]
    let ref = Unmanaged.passUnretained(counts).toOpaque()
    var registered: [String] = []
    for n in notes where AXObserverAddNotification(obs, app, n as CFString, ref) == .success { registered.append(n as String) }
    CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .defaultMode)
    CFRunLoopRunInMode(.defaultMode, seconds, false)
    let total = counts.n.values.reduce(0, +)
    print("registered=\(registered.count) seconds=\(Int(seconds)) " + counts.n.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: " ") + " total=\(total)")
case "poll":
    // cdax poll <pid> <seconds>: walks the app's windows (what VoiceOver reads) every 250 ms and
    // counts the nodes that appear and disappear between samples (role + title + description, as a
    // multiset). A flickering tree shows adds and removes on every sample; a stable one stays at 0.
    let app = AXUIElementCreateApplication(pid_t(args[2])!)
    let seconds = Double(args[3]) ?? 60
    func snapshot() -> [String: Int] {
        var out: [String: Int] = [:]
        func walk(_ e: AXUIElement, _ depth: Int) {
            guard depth < 60 else { return }
            let role = str(e, kAXRoleAttribute)
            if role == "AXMenuBar" { return }
            // Digits dropped: a label that counts ("Recording 3:10") is a value change, not a node
            // coming and going.
            let key = "\(role)|\(str(e, kAXTitleAttribute))|\(str(e, kAXDescriptionAttribute))".filter { !$0.isNumber }
            out[key, default: 0] += 1
            for c in children(e) { walk(c, depth + 1) }
        }
        for w in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { walk(w, 0) }
        return out
    }
    var prev = snapshot()
    var adds = 0, removes = 0, samples = 0, nodes = 0
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
        usleep(250_000)
        let cur = snapshot()
        samples += 1
        nodes = cur.values.reduce(0, +)
        for (k, v) in cur where v > (prev[k] ?? 0) { adds += v - (prev[k] ?? 0) }
        for (k, v) in prev where v > (cur[k] ?? 0) { removes += v - (cur[k] ?? 0) }
        prev = cur
    }
    print("samples=\(samples) nodes=\(nodes) adds=\(adds) removes=\(removes) total=\(adds + removes)")
default:
    print("usage: cdax trusted|tree|focus|key|windows|press|observe|poll")
}
