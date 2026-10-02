/**
 * A path the editor's import commands accept for a file dropped on the
 * window. The desktop app receives native drops as real paths through Tauri,
 * so there is nothing to register here; the web editor swaps this module for
 * one that hands the File to its file-picker bridge.
 */
export function pathForDroppedFile(_file: File): string | null {
	return null;
}
