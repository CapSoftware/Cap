import Foundation
import Quartz
import CapShared

@objc(PreviewProvider)
final class PreviewProvider: QLPreviewProvider, QLPreviewingController {
	func providePreview(for request: QLFilePreviewRequest) async throws -> QLPreviewReply {
		if let video = CapProject.exportedVideo(in: request.fileURL) {
			return QLPreviewReply(fileURL: video)
		}
		if let image = CapProject.previewImage(in: request.fileURL) {
			return QLPreviewReply(fileURL: image)
		}
		throw CocoaError(.fileReadNoSuchFile)
	}
}
