// The editor's file route answers 404 for a saved image whose object is gone
// from storage. The preview and export draw nothing in its place, as the
// renderer does for an image path it can't find, while any other failure
// still stops the load.
export const MISSING_EDITOR_IMAGE = "Editor image is gone";

export function isMissingEditorImage(error: unknown) {
	return error instanceof Error && error.message === MISSING_EDITOR_IMAGE;
}
