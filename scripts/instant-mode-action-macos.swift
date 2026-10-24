import AppKit
import CoreGraphics
import Darwin
import Foundation

func fail(_ message: String) -> Never {
	FileHandle.standardError.write(Data("\(message)\n".utf8))
	exit(1)
}

guard CommandLine.arguments.count == 3 else {
	fail("usage: instant-mode-action-macos <pid> <url>")
}

guard let pid = pid_t(CommandLine.arguments[1]), kill(pid, 0) == 0 else {
	fail("target process is not running")
}

if CommandLine.arguments[2] == "--windows" {
	let rawWindows = CGWindowListCopyWindowInfo(
		[.optionAll, .excludeDesktopElements],
		kCGNullWindowID
	) as? [[String: Any]] ?? []
	let windows = rawWindows.compactMap { window -> [String: Any]? in
		guard
			let ownerPid = window[kCGWindowOwnerPID as String] as? NSNumber,
			ownerPid.int32Value == pid
		else {
			return nil
		}

		let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
		return [
			"alpha": window[kCGWindowAlpha as String] as? NSNumber ?? 0,
			"bounds": bounds,
			"layer": window[kCGWindowLayer as String] as? NSNumber ?? 0,
			"name": window[kCGWindowName as String] as? String ?? "",
			"number": window[kCGWindowNumber as String] as? NSNumber ?? 0,
			"on_screen": window[kCGWindowIsOnscreen as String] as? NSNumber ?? false,
			"owner_name": window[kCGWindowOwnerName as String] as? String ?? "",
		]
	}
	let output: [String: Any] = [
		"pid": Int(pid),
		"windows": windows,
	]
	guard
		let data = try? JSONSerialization.data(
			withJSONObject: output,
			options: [.sortedKeys]
		)
	else {
		fail("failed to serialize window state")
	}
	FileHandle.standardOutput.write(data)
	FileHandle.standardOutput.write(Data("\n".utf8))
	exit(0)
}

let target = NSAppleEventDescriptor(processIdentifier: pid)
let event = NSAppleEventDescriptor(
	eventClass: AEEventClass(kInternetEventClass),
	eventID: AEEventID(kAEGetURL),
	targetDescriptor: target,
	returnID: AEReturnID(kAutoGenerateReturnID),
	transactionID: AETransactionID(kAnyTransactionID)
)
event.setParam(
	NSAppleEventDescriptor(string: CommandLine.arguments[2]),
	forKeyword: AEKeyword(keyDirectObject)
)

let status = AESendMessage(
	event.aeDesc,
	nil,
	AESendMode(kAENoReply),
	Int(kAEDefaultTimeout)
)
guard status == noErr else {
	fail("AESendMessage failed with status \(status)")
}
