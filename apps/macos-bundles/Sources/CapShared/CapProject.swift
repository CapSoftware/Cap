import Foundation

public enum CapProject {
	public static func previewImage(in bundle: URL) -> URL? {
		let screenshot = bundle.appendingPathComponent("screenshots/display.jpg")
		if isReadableFile(screenshot) {
			return screenshot
		}
		guard let path = recordingDisplayPath(in: bundle) else {
			return nil
		}
		let original = bundle.appendingPathComponent(path)
		return isReadableFile(original) ? original : nil
	}

	public static func exportedVideo(in bundle: URL) -> URL? {
		let video = bundle.appendingPathComponent("output/result.mp4")
		return isReadableFile(video) ? video : nil
	}

	private static func recordingDisplayPath(in bundle: URL) -> String? {
		let meta = bundle.appendingPathComponent("recording-meta.json")
		guard let data = try? Data(contentsOf: meta),
			let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
			let display = json["display"] as? [String: Any],
			let path = display["path"] as? String,
			!path.isEmpty,
			!path.hasPrefix("/"),
			!path.split(separator: "/").contains("..")
		else {
			return nil
		}
		return path
	}

	private static func isReadableFile(_ url: URL) -> Bool {
		var isDirectory: ObjCBool = false
		return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
			&& !isDirectory.boolValue
			&& FileManager.default.isReadableFile(atPath: url.path)
	}
}
