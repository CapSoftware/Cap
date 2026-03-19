import { cx } from "cva";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	onCleanup,
	Show,
} from "solid-js";
import { Portal } from "solid-js/web";

export type DeviceSelectOverlayProps<T> = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	anchorRef: Accessor<HTMLElement | undefined>;
	items: T[];
	selectedItem: T | null;
	onSelect: (item: T | null) => void;
	renderItem: (item: T, isSelected: boolean) => JSX.Element;
	renderStats?: (item: T) => JSX.Element;
	keyExtractor: (item: T) => string;
	emptyMessage?: string;
	noneLabel?: string;
	title?: string;
	showNoneOption?: boolean;
};

export default function DeviceSelectOverlay<T>(
	props: DeviceSelectOverlayProps<T>,
) {
	let overlayRef: HTMLDivElement | undefined;
	let listRef: HTMLDivElement | undefined;
	const [searchQuery, setSearchQuery] = createSignal("");
	const [position, setPosition] = createSignal({ top: 0, left: 0 });

	const filteredItems = createMemo(() => {
		const query = searchQuery().toLowerCase().trim();
		if (!query) return props.items;
		return props.items.filter((item) => {
			const key = props.keyExtractor(item);
			return key.toLowerCase().includes(query);
		});
	});

	createEffect(() => {
		if (props.open) {
			setSearchQuery("");
			const anchor = props.anchorRef();
			if (anchor) {
				const rect = anchor.getBoundingClientRect();
				setPosition({
					top: rect.bottom + 8,
					left: rect.left,
				});
			}

			setTimeout(() => {
				const selected = listRef?.querySelector<HTMLButtonElement>(
					'button[data-device-item][data-selected="true"]',
				);
				if (selected) {
					selected.focus();
					selected.scrollIntoView({ block: "nearest" });
				} else {
					const firstItem = listRef?.querySelector<HTMLButtonElement>(
						"button[data-device-item]",
					);
					firstItem?.focus();
				}
			}, 50);
		}
	});

	createEffect(() => {
		if (!props.open) return;

		const handleClickOutside = (e: MouseEvent) => {
			const anchor = props.anchorRef();
			if (
				overlayRef &&
				!overlayRef.contains(e.target as Node) &&
				anchor &&
				!anchor.contains(e.target as Node)
			) {
				props.onOpenChange(false);
			}
		};

		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				props.onOpenChange(false);
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		document.addEventListener("keydown", handleEscape);

		onCleanup(() => {
			document.removeEventListener("mousedown", handleClickOutside);
			document.removeEventListener("keydown", handleEscape);
		});
	});

	const handleKeyDown = (e: KeyboardEvent) => {
		const buttons = listRef?.querySelectorAll<HTMLButtonElement>(
			"button[data-device-item]",
		);
		if (!buttons) return;

		const focusedIndex = Array.from(buttons).indexOf(
			document.activeElement as HTMLButtonElement,
		);

		switch (e.key) {
			case "ArrowDown": {
				e.preventDefault();
				const nextIndex =
					focusedIndex < buttons.length - 1 ? focusedIndex + 1 : 0;
				buttons[nextIndex]?.focus();
				break;
			}
			case "ArrowUp": {
				e.preventDefault();
				const prevIndex =
					focusedIndex > 0 ? focusedIndex - 1 : buttons.length - 1;
				buttons[prevIndex]?.focus();
				break;
			}
			case "Home": {
				e.preventDefault();
				buttons[0]?.focus();
				break;
			}
			case "End": {
				e.preventDefault();
				buttons[buttons.length - 1]?.focus();
				break;
			}
		}
	};

	return (
		<Show when={props.open}>
			<Portal>
				<div
					ref={overlayRef}
					class={cx(
						"fixed z-50 flex flex-col overflow-hidden rounded-xl shadow-lg w-[280px]",
						"animate-in fade-in zoom-in-95 origin-top-left duration-150",
					)}
					style={{
						top: `${position().top}px`,
						left: `${position().left}px`,
						"background-color": "rgba(30, 30, 30, 0.95)",
						"backdrop-filter": "blur(12px)",
						border: "1px solid rgba(255, 255, 255, 0.1)",
					}}
					onKeyDown={handleKeyDown}
				>
					<Show when={props.title}>
						<div
							class="px-3 py-2.5"
							style={{ "border-bottom": "1px solid rgba(255, 255, 255, 0.1)" }}
						>
							<h3 class="text-xs font-medium text-white/60">{props.title}</h3>
						</div>
					</Show>

					<Show when={props.items.length > 5}>
						<div class="px-2 pt-2">
							<input
								type="text"
								placeholder="Search..."
								value={searchQuery()}
								onInput={(e) => setSearchQuery(e.currentTarget.value)}
								class="w-full px-3 py-1.5 text-sm rounded-lg outline-none placeholder:text-white/40 text-white"
								style={{
									"background-color": "rgba(255, 255, 255, 0.1)",
									border: "1px solid rgba(255, 255, 255, 0.1)",
								}}
							/>
						</div>
					</Show>

					<div
						ref={listRef}
						class="flex flex-col p-1.5 overflow-y-auto max-h-[320px]"
						style={{
							"scrollbar-width": "thin",
							"scrollbar-color": "rgba(255,255,255,0.2) transparent",
						}}
					>
						<Show when={props.showNoneOption !== false}>
							<button
								type="button"
								data-device-item
								data-selected={props.selectedItem === null}
								onClick={() => {
									props.onSelect(null);
									props.onOpenChange(false);
								}}
								class={cx(
									"flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm transition-colors text-left",
									props.selectedItem === null
										? "bg-blue-500 text-white"
										: "hover:bg-white/10 text-white/70",
								)}
							>
								<IconLucideCircleOff class="size-4 shrink-0" />
								<span class="truncate">{props.noneLabel ?? "None"}</span>
								<Show when={props.selectedItem === null}>
									<IconLucideCheck class="size-4 ml-auto shrink-0" />
								</Show>
							</button>
						</Show>

						<Show
							when={filteredItems().length > 0}
							fallback={
								<div class="px-3 py-6 text-center text-sm text-white/50">
									{searchQuery()
										? "No matching devices"
										: (props.emptyMessage ?? "No devices found")}
								</div>
							}
						>
							<For each={filteredItems()}>
								{(item) => {
									const isSelected = () =>
										props.selectedItem !== null &&
										props.keyExtractor(props.selectedItem) ===
											props.keyExtractor(item);

									return (
										<button
											type="button"
											data-device-item
											data-selected={isSelected()}
											onClick={() => {
												props.onSelect(item);
												props.onOpenChange(false);
											}}
											class={cx(
												"flex flex-col gap-0.5 px-2.5 py-2 rounded-lg text-sm transition-colors text-left",
												isSelected()
													? "bg-blue-500 text-white"
													: "hover:bg-white/10 text-white",
											)}
										>
											<div class="flex items-center gap-2 w-full">
												{props.renderItem(item, isSelected())}
												<Show when={isSelected()}>
													<IconLucideCheck class="size-4 ml-auto shrink-0" />
												</Show>
											</div>
											<Show when={props.renderStats}>
												{(renderStats) => (
													<div
														class={cx(
															"text-[11px] pl-6",
															isSelected() ? "text-white/70" : "text-white/50",
														)}
													>
														{renderStats()(item)}
													</div>
												)}
											</Show>
										</button>
									);
								}}
							</For>
						</Show>
					</div>
				</div>
			</Portal>
		</Show>
	);
}
