import { native } from "./bridge";
import { listen } from "./event";
import type { LogicalPosition, PhysicalPosition } from "./dpi";

let nextMenuId = 1;

export interface MenuItemOptions {
	id?: string;
	text?: string;
	enabled?: boolean;
	accelerator?: string;
	action?: (id: string) => unknown;
	items?: MenuEntry[];
}

export interface CheckMenuItemOptions extends MenuItemOptions { checked?: boolean; }
export interface PredefinedMenuItemOptions { item: string; text?: string; }

export class MenuItem {
	id: string;
	text?: string;
	enabled?: boolean;
	accelerator?: string;
	action?: (id: string) => unknown;
	items?: MenuEntry[];

	constructor(options: MenuItemOptions) {
		this.id = options.id ?? `cap-menu-${nextMenuId++}`;
		Object.assign(this, options);
	}

	static async new(options: MenuItemOptions) { return new MenuItem(options); }
	async setText(text: string) { this.text = text; }
	async setEnabled(enabled: boolean) { this.enabled = enabled; }
}

export class CheckMenuItem extends MenuItem {
	checked: boolean;
	constructor(options: CheckMenuItemOptions) {
		super(options);
		this.checked = options.checked ?? false;
	}
	static async new(options: CheckMenuItemOptions) { return new CheckMenuItem(options); }
	async setChecked(checked: boolean) { this.checked = checked; }
	async isChecked() { return this.checked; }
}

export class PredefinedMenuItem extends MenuItem {
	item: string;
	constructor(options: PredefinedMenuItemOptions) {
		super({ text: options.text });
		this.item = options.item;
	}
	static async new(options: PredefinedMenuItemOptions) { return new PredefinedMenuItem(options); }
}

export class Submenu extends MenuItem {
	static async new(options: MenuItemOptions) { return new Submenu(options); }
}

export type MenuEntry = MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu | MenuItemOptions;

export class Menu {
	constructor(public items: MenuEntry[]) {}
	static async new(options: { id?: string; items?: MenuEntry[] } = {}) { return new Menu(options.items ?? []); }

	async popup(position?: LogicalPosition | PhysicalPosition) {
		const unlisteners = await Promise.all(this.items.flatMap(flattenItems).filter((item) => item.action).map(async (item) => {
			const id = item.id ?? `cap-menu-${nextMenuId++}`;
			item.id = id;
			return listen(`menu:${id}`, () => item.action?.(id));
		}));
		await native<void>("menu.popup", {
			items: this.items.map(serializeItem),
			position: position ? { x: position.x, y: position.y } : undefined,
		});
		setTimeout(() => unlisteners.forEach((unlisten) => unlisten()), 30000);
	}

	async append(item: MenuEntry) { this.items.push(item); }
	async prepend(item: MenuEntry) { this.items.unshift(item); }
	async insert(item: MenuEntry, position: number) { this.items.splice(position, 0, item); }
	async remove(item: MenuEntry) { this.items = this.items.filter((entry) => entry !== item); }
	async removeAt(position: number) { return this.items.splice(position, 1)[0] ?? null; }
	async itemsList() { return this.items; }
	async close() {}
}

function flattenItems(item: MenuEntry): MenuEntry[] {
	return [item, ...(item.items?.flatMap(flattenItems) ?? [])];
}

function serializeItem(item: MenuEntry): Record<string, unknown> {
	if (item instanceof PredefinedMenuItem && item.item.toLowerCase() === "separator") return { type: "separator" };
	return {
		id: item.id,
		text: item.text,
		enabled: item.enabled,
		accelerator: item.accelerator,
		checked: item instanceof CheckMenuItem ? item.checked : undefined,
		items: item.items?.map(serializeItem),
	};
}
