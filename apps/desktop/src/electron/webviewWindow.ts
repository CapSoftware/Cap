import { bridge, native } from "./bridge";
import { Window } from "./window";

export interface WebviewWindowOptions {
	url?: string;
	title?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	minWidth?: number;
	minHeight?: number;
	transparent?: boolean;
	decorations?: boolean;
	resizable?: boolean;
	alwaysOnTop?: boolean;
	visibleOnAllWorkspaces?: boolean;
	skipTaskbar?: boolean;
	contentProtected?: boolean;
	focus?: boolean;
	visible?: boolean;
	initialization?: Record<string, unknown>;
	[key: string]: unknown;
}

export class WebviewWindow extends Window {
	constructor(label: string, options?: WebviewWindowOptions) {
		super(label);
		if (options) {
			void native("window.create", {
				label,
				route: options.url ?? "/",
				...options,
				initialization: options.initialization ?? null,
			});
		}
	}

	static async getByLabel(label: string) {
		const labels = await native<string[]>("window.all");
		return labels.includes(label) ? new WebviewWindow(label) : null;
	}

	static async getAll() {
		return (await native<string[]>("window.all")).map(
			(label) => new WebviewWindow(label),
		);
	}

	static getCurrent() {
		return new WebviewWindow(bridge().windowLabel);
	}

	emitTo(_target: string, event: string, payload?: unknown) {
		return this.emit(event, payload);
	}
}

export function getCurrentWebviewWindow() {
	return new WebviewWindow(bridge().windowLabel);
}

export function getAllWebviewWindows() {
	return WebviewWindow.getAll();
}
