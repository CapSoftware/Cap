import { LogicalPosition } from "@tauri-apps/api/dpi";
import { CheckMenuItem, Menu, MenuItem } from "@tauri-apps/api/menu";
import { cx } from "cva";
import type { JSX } from "solid-js";
import type { TimelineTrackType } from "../context";

type TrackManagerOption = {
	type: TimelineTrackType;
	label: string;
	active: boolean;
	available: boolean;
	locked: boolean;
	supportsMultiple?: boolean;
};

export function TrackManager(props: {
	options: TrackManagerOption[];
	onToggle(type: TimelineTrackType, next: boolean): void;
	onAdd(type: TimelineTrackType): void;
}) {
	let addButton: HTMLButtonElement | undefined;

	const handleOpenMenu = async () => {
		try {
			const items = [];
			for (const option of props.options) {
				if (option.locked) {
					continue;
				}

				if (option.supportsMultiple) {
					items.push(
						await MenuItem.new({
							text: `Add ${option.label} track`,
							enabled: option.available,
							action: () => props.onAdd(option.type),
						}),
					);
					continue;
				}

				items.push(
					await CheckMenuItem.new({
						text: option.label,
						checked: option.active,
						enabled: option.available,
						action: () => props.onToggle(option.type, !option.active),
					}),
				);
			}

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
			class="relative z-30 flex h-12 items-center justify-center gap-1.5 rounded-xl border border-gray-4/70 bg-gray-1 px-2.5 text-[0.8125rem] font-medium text-gray-12 shadow-[0_4px_16px_-12px_rgba(0,0,0,0.8)] transition-colors duration-150 hover:bg-gray-3 dark:border-gray-4/60 dark:bg-gray-3/40"
			onClick={handleOpenMenu}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<IconLucidePlus class="size-3.5" />
			<span>Add track</span>
		</button>
	);
}

export function TrackIcon(props: { icon: JSX.Element; class?: string }) {
	return (
		<div
			class={cx(
				"relative z-10 w-[3.5rem] h-[3.25rem] flex items-center justify-center rounded-xl border border-gray-4/70 bg-gray-2/60 text-gray-12 shadow-[0_4px_16px_-12px_rgba(0,0,0,0.8)] dark:border-gray-4/60 dark:bg-gray-3/40",
				props.class,
			)}
			onMouseDown={(e) => e.stopPropagation()}
		>
			{props.icon}
		</div>
	);
}
