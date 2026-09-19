type MenuItemOptions = {
	id?: string;
	text: string;
	action?: () => void | Promise<void>;
	enabled?: boolean;
	checked?: boolean;
};

type SeparatorOptions = { item: "Separator" };
type MenuEntry = MenuItemOptions | SeparatorOptions;

let pointerX = 0;
let pointerY = 0;
let openMenu: HTMLElement | null = null;
let menuCleanup: (() => void) | null = null;

if (typeof window !== "undefined") {
	window.addEventListener(
		"pointermove",
		(event) => {
			pointerX = event.clientX;
			pointerY = event.clientY;
		},
		{ passive: true },
	);
}

function closeOpenMenu() {
	menuCleanup?.();
	menuCleanup = null;
	openMenu?.remove();
	openMenu = null;
}

function makeItem(entry: MenuItemOptions, close: () => void) {
	const button = document.createElement("button");
	button.type = "button";
	const indicator = document.createElement("span");
	indicator.setAttribute("aria-hidden", "true");
	indicator.textContent = entry.checked ? "✓" : "";
	indicator.style.cssText =
		"display:inline-block;width:14px;flex:none;text-align:center";
	const label = document.createElement("span");
	label.textContent = entry.text;
	button.append(indicator, label);
	button.setAttribute(
		"role",
		entry.checked === undefined ? "menuitem" : "menuitemcheckbox",
	);
	if (entry.checked !== undefined) {
		button.setAttribute("aria-checked", String(entry.checked));
	}
	button.disabled = entry.enabled === false;
	button.style.cssText =
		"display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:4px 13px;background:transparent;border:0;border-radius:5px;color:inherit;text-align:left;font:inherit;cursor:pointer;white-space:nowrap";
	button.style.opacity = button.disabled ? ".45" : "1";
	button.addEventListener("pointerenter", () => {
		if (!button.disabled) button.focus();
	});
	button.addEventListener("focus", () => {
		button.style.background = "rgba(128,128,128,.24)";
	});
	button.addEventListener("blur", () => {
		button.style.background = "transparent";
	});
	button.addEventListener("click", () => {
		close();
		if (entry.action) void Promise.resolve(entry.action()).catch(console.error);
	});
	return button;
}

function positionMenu(
	menu: HTMLElement,
	x: number,
	y: number,
	dialog: HTMLElement | null,
) {
	const width = menu.offsetWidth;
	const height = menu.offsetHeight;
	const bounds = dialog?.getBoundingClientRect();
	const availableWidth = bounds?.width ?? window.innerWidth;
	const availableHeight = bounds?.height ?? window.innerHeight;
	menu.style.left = `${Math.max(8, Math.min(x - (bounds?.left ?? 0), availableWidth - width - 8))}px`;
	menu.style.top = `${Math.max(8, Math.min(y - (bounds?.top ?? 0), availableHeight - height - 8))}px`;
}

export const MenuItem = {
	async new(options: MenuItemOptions) {
		return options;
	},
};

export const CheckMenuItem = {
	async new(options: MenuItemOptions & { checked: boolean }) {
		return options;
	},
};

export class Menu {
	constructor(private readonly items: MenuEntry[]) {}

	static async new(options: { items: MenuEntry[]; id?: string }) {
		return new Menu(options.items);
	}

	async popup(position?: { x: number; y: number }) {
		closeOpenMenu();
		const previousFocus =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		const dialog =
			previousFocus?.closest<HTMLElement>('[role="dialog"][data-expanded]') ??
			Array.from(
				document.querySelectorAll<HTMLElement>(
					'[role="dialog"][data-expanded]',
				),
			).at(-1) ??
			null;
		const menu = document.createElement("div");
		menu.setAttribute("role", "menu");
		menu.setAttribute("aria-label", "Editor actions");
		menu.style.cssText =
			"position:fixed;z-index:2147483646;min-width:170px;max-width:min(320px,calc(100vw - 16px));padding:5px;background:var(--ed-card-2);color:var(--ed-text-1);border:1px solid var(--ed-line-strong);border-radius:8px;box-shadow:var(--ed-pop-shadow);font:13px system-ui,sans-serif";
		const controller = new AbortController();
		const close = () => {
			closeOpenMenu();
			previousFocus?.focus({ preventScroll: true });
		};
		const buttons: HTMLButtonElement[] = [];
		for (const entry of this.items) {
			if ("item" in entry) {
				const separator = document.createElement("div");
				separator.setAttribute("role", "separator");
				separator.style.cssText =
					"height:1px;margin:4px 7px;background:var(--ed-line-strong)";
				menu.append(separator);
				continue;
			}
			const button = makeItem(entry, close);
			buttons.push(button);
			menu.append(button);
		}
		if (dialog) menu.style.position = "absolute";
		(dialog ?? document.body).append(menu);
		openMenu = menu;
		menuCleanup = () => controller.abort();
		positionMenu(
			menu,
			position?.x ?? pointerX,
			position?.y ?? pointerY,
			dialog,
		);
		const enabled = buttons.filter((button) => !button.disabled);
		enabled[0]?.focus({ preventScroll: true });
		document.addEventListener(
			"pointerdown",
			(event) => {
				if (!menu.contains(event.target as Node)) close();
			},
			{ capture: true, signal: controller.signal },
		);
		window.addEventListener(
			"keydown",
			(event) => {
				if (event.key === "Escape" || event.key === "Tab") {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
					}
					close();
					return;
				}
				if (
					event.key !== "ArrowDown" &&
					event.key !== "ArrowUp" &&
					event.key !== "Home" &&
					event.key !== "End"
				) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				if (enabled.length === 0) return;
				const current = enabled.indexOf(
					document.activeElement as HTMLButtonElement,
				);
				const next =
					event.key === "Home"
						? 0
						: event.key === "End"
							? enabled.length - 1
							: (current +
									(event.key === "ArrowDown" ? 1 : -1) +
									enabled.length) %
								enabled.length;
				enabled[next]?.focus({ preventScroll: true });
			},
			{ capture: true, signal: controller.signal },
		);
	}
}
