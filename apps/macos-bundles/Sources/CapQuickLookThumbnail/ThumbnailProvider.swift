import Foundation
import QuickLookThumbnailing
import CapShared

@objc(ThumbnailProvider)
final class ThumbnailProvider: QLThumbnailProvider {
	override func provideThumbnail(
		for request: QLFileThumbnailRequest,
		_ handler: @escaping (QLThumbnailReply?, Error?) -> Void
	) {
		guard let image = CapProject.previewImage(in: request.fileURL) else {
			handler(nil, CocoaError(.fileReadNoSuchFile))
			return
		}
		handler(QLThumbnailReply(imageFileURL: image), nil)
	}
}
