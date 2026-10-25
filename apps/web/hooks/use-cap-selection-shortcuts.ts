import { type Dispatch, type SetStateAction, useEffect } from "react";

export function useCapSelectionShortcuts<T extends string>({
	enabled,
	items,
	setSelected,
}: {
	enabled: boolean;
	items: readonly { id: T }[];
	setSelected: Dispatch<SetStateAction<T[]>>;
}) {
	useEffect(() => {
		if (!enabled || items.length === 0) return;

		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.isComposing ||
				event.altKey ||
				event.shiftKey ||
				!(event.ctrlKey || event.metaKey) ||
				event.key.toLowerCase() !== "a"
			) {
				return;
			}

			const target =
				event.target instanceof Element ? event.target : document.activeElement;
			if (
				target?.closest(
					'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="dialog"], [role="alertdialog"]',
				) ||
				document.querySelector(
					'[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], dialog[open]',
				)
			) {
				return;
			}

			event.preventDefault();
			setSelected(items.map((item) => item.id));
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [enabled, items, setSelected]);
}
