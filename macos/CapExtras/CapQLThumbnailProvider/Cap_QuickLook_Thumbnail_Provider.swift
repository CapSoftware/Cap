//
//  ThumbnailProvider.swift
//  CapQLThumbnailProvider
//

import QuickLookThumbnailing

class Cap_QuickLook_Thumbnail_Provider: QLThumbnailProvider {
    
    override func provideThumbnail(for request: QLFileThumbnailRequest, _ handler: @escaping (QLThumbnailReply?, Error?) -> Void) {
        let imageURL = request.fileURL
            .appendingPathComponent("screenshots", isDirectory: true)
            .appendingPathComponent("display.jpg", isDirectory: false)

        let reply = QLThumbnailReply(imageFileURL: imageURL)
        handler(reply, nil)
    }
}
