import Photos

nonisolated enum PhotoLibrary {
    /// Photos runs the change block on its own queue. Written here, outside the main actor, the block isn't
    /// inferred as main-actor code, which Swift checks at runtime and stops the app for.
    static func addVideo(at url: URL) async throws {
        try await PHPhotoLibrary.shared().performChanges {
            PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: url)
        }
    }
}
