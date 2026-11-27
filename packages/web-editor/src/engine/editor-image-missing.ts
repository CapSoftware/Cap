// The editor's file route answers 410 only for a saved image whose object
// storage reports as gone; its 404s mean the request itself isn't allowed.
// The preview and export draw nothing in place of a gone image, as the
// renderer does for an image path it can't find, while any other failure
// still stops the load.
export const MISSING_EDITOR_IMAGE = "Editor image is gone";

export const EXPORT_ASSET_FAILED = "Export asset could not load";

export function isMissingEditorImage(error: unknown) {
	return error instanceof Error && error.message === MISSING_EDITOR_IMAGE;
}
