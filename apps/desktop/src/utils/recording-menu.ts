import type { LogicalPosition } from "@tauri-apps/api/dpi";
import type { Menu } from "@tauri-apps/api/menu";

export function createRecordingMenuPopup() {
	let active = false;

	return async (
		createMenu: () => Promise<Pick<Menu, "popup">>,
		position: LogicalPosition,
	) => {
		if (active) return;
		active = true;
		try {
			const menu = await createMenu();
			await menu.popup(position);
		} finally {
			active = false;
		}
	};
}
