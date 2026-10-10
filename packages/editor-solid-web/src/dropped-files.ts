import { registerEditorFile } from "./tauri-dialog";

/** Web stand-in for ~/utils/dropped-files: dropped files go through the same
 * token bridge as files chosen in the file picker. */
export function pathForDroppedFile(file: File): string | null {
	return registerEditorFile(file);
}
