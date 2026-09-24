import { invokeEditorTauriCommand } from "./tauri-bridge";

export function revealItemInDir(path: string) {
	return invokeEditorTauriCommand<void>("download_editor_bundle", { path });
}
