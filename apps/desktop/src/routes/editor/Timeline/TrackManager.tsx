import { LogicalPosition } from "@tauri-apps/api/dpi";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import type { JSX } from "solid-js";

import type { TimelineTrackType } from "../context";

type TrackManagerOption = {
	type: TimelineTrackType;
	label: string;
	icon: JSX.Element;
	active: boolean;
	available: boolean;
};

export function TrackManager(props: {
	options: TrackManagerOption[];
	onToggle(type: TimelineTrackType, next: boolean): void;
}) {
	let addButton: HTMLButtonElement | undefined;

	const handleOpenMenu = async () => {
		try {
			const items = await Promise.all(
				props.options.map((option) => {
					if (option.type === "scene") {
						return CheckMenuItem.new({
							text: option.label,
							checked: option.active,
							enabled: option.available,
							action: () => props.onToggle(option.type, !option.active),
						});
					}

					return CheckMenuItem.new({
						text: option.label,
						checked: true,
						enabled: false,
					});
				}),
			);

			const menu = await Menu.new({ items });
			const rect = addButton?.getBoundingClientRect();
			if (rect) {
				menu.popup(new LogicalPosition(rect.x, rect.y + rect.height + 4));
			} else {
				menu.popup();
			}
		} catch (error) {
			console.error("Failed to open track menu", error);
		}
	};

	return (
		<button
			ref={(el) => {
				addButton = el;
			}}
			class="flex h-8 w-9 items-center justify-center rounded-lg border border-gray-4/80 bg-gray-2 text-sm font-medium text-gray-12 transition-colors duration-150 hover:bg-gray-3 dark:border-gray-5/60 dark:bg-gray-4/50"
			onClick={handleOpenMenu}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<IconLucidePlus class="size-4" />
		</button>
	);
}

export function TrackIcon(props: { icon: JSX.Element }) {
	return (
		<div
			class="relative z-10 w-[3.5rem] h-[3.25rem] flex items-center justify-center rounded-xl border border-gray-4/70 bg-gray-2/60 text-gray-12 shadow-[0_4px_16px_-12px_rgba(0,0,0,0.8)] dark:border-gray-4/60 dark:bg-gray-3/40"
			onMouseDown={(e) => e.stopPropagation()}
		>
			{props.icon}
		</div>
	);
}
