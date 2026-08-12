import { bridge, native } from "./bridge";
import {
	LogicalPosition,
	LogicalSize,
	PhysicalPosition,
	PhysicalSize,
	type Position,
	type Size,
} from "./dpi";
import { type Event, emit, listen, once, type UnlistenFn } from "./event";

export enum UserAttentionType {
	Critical = 1,
	Informational = 2,
}

export enum ProgressBarStatus {
	None = "none",
	Normal = "normal",
	Indeterminate = "indeterminate",
	Paused = "paused",
	Error = "error",
}

export enum Effect {
	AppearanceBased = "appearanceBased",
	Light = "light",
	Dark = "dark",
	MediumLight = "mediumLight",
	UltraDark = "ultraDark",
	Titlebar = "titlebar",
	Selection = "selection",
	Menu = "menu",
	Popover = "popover",
	Sidebar = "sidebar",
	HeaderView = "headerView",
	Sheet = "sheet",
	WindowBackground = "windowBackground",
	HudWindow = "hudWindow",
	FullScreenUI = "fullScreenUI",
	Tooltip = "tooltip",
	ContentBackground = "contentBackground",
	UnderWindowBackground = "underWindowBackground",
	UnderPageBackground = "underPageBackground",
	Mica = "mica",
	MicaDark = "micaDark",
	MicaLight = "micaLight",
	Tabbed = "tabbed",
	TabbedDark = "tabbedDark",
	TabbedLight = "tabbedLight",
}

export enum EffectState {
	FollowsWindowActiveState = "followsWindowActiveState",
	Active = "active",
	Inactive = "inactive",
}

export interface Effects {
	effects: Effect[];
	state?: EffectState;
	radius?: number;
	color?: string;
}

export type Theme = "light" | "dark";

interface WindowState {
	x: number;
	y: number;
	width: number;
	height: number;
	visible: boolean;
	focused: boolean;
	minimized: boolean;
	maximized: boolean;
	fullscreen: boolean;
	alwaysOnTop: boolean;
	resizable?: boolean;
	decorated?: boolean;
	scaleFactor: number;
}

export interface Monitor {
	name: string | null;
	scaleFactor: number;
	position: PhysicalPosition;
	size: PhysicalSize;
	workArea: { position: PhysicalPosition; size: PhysicalSize };
}

interface SerializedMonitor {
	name: string | null;
	scaleFactor: number;
	position: { x: number; y: number };
	size: { width: number; height: number };
	workArea: {
		position: { x: number; y: number };
		size: { width: number; height: number };
	};
}

function hydrateMonitor(monitor: SerializedMonitor | null): Monitor | null {
	if (!monitor) return null;
	return {
		...monitor,
		position: new PhysicalPosition(monitor.position.x, monitor.position.y),
		size: new PhysicalSize(monitor.size.width, monitor.size.height),
		workArea: {
			position: new PhysicalPosition(
				monitor.workArea.position.x,
				monitor.workArea.position.y,
			),
			size: new PhysicalSize(
				monitor.workArea.size.width,
				monitor.workArea.size.height,
			),
		},
	};
}

export class CloseRequestedEvent {
	event = "tauri://close-requested";
	id = 0;
	payload = undefined;
	preventDefault() {}
}

export class Window {
	constructor(public label: string) {}

	static async getByLabel(label: string) {
		const labels = await native<string[]>("window.all");
		return labels.includes(label) ? new Window(label) : null;
	}

	static async getAll() {
		return (await native<string[]>("window.all")).map(
			(label) => new Window(label),
		);
	}

	private action<T>(action: string, value?: Record<string, unknown>) {
		return native<T>("window.action", { label: this.label, action, value });
	}

	private state() {
		return this.action<WindowState>("state");
	}

	async scaleFactor() {
		return (await this.state()).scaleFactor;
	}
	async innerPosition() {
		const state = await this.state();
		return new PhysicalPosition(state.x, state.y);
	}
	async outerPosition() {
		return this.innerPosition();
	}
	async innerSize() {
		const state = await this.state();
		return new PhysicalSize(state.width, state.height);
	}
	async outerSize() {
		return this.innerSize();
	}
	async isFullscreen() {
		return (await this.state()).fullscreen;
	}
	async isMinimized() {
		return (await this.state()).minimized;
	}
	async isMaximized() {
		return (await this.state()).maximized;
	}
	async isFocused() {
		return (await this.state()).focused;
	}
	async isDecorated() {
		return (await this.state()).decorated ?? false;
	}
	async isResizable() {
		return (await this.state()).resizable ?? true;
	}
	async isMaximizable() {
		return true;
	}
	async isMinimizable() {
		return true;
	}
	async isClosable() {
		return true;
	}
	async isVisible() {
		return (await this.state()).visible;
	}
	async title() {
		return document.title;
	}
	async currentMonitor() {
		return hydrateMonitor(
			await native<SerializedMonitor | null>("window.currentMonitor"),
		);
	}
	async primaryMonitor() {
		return hydrateMonitor(
			await native<SerializedMonitor | null>("window.primaryMonitor"),
		);
	}
	async monitorFromPoint(x: number, y: number) {
		return hydrateMonitor(
			await native<SerializedMonitor | null>("window.monitorFromPoint", {
				x,
				y,
			}),
		);
	}
	async availableMonitors() {
		return (await native<SerializedMonitor[]>("window.availableMonitors")).map(
			(monitor) => hydrateMonitor(monitor) as Monitor,
		);
	}
	async theme(): Promise<Theme | null> {
		return native("theme.get");
	}

	center() {
		return this.action<void>("center");
	}
	requestUserAttention(requestType: UserAttentionType | null) {
		return this.action<void>("requestUserAttention", {
			critical: requestType === UserAttentionType.Critical,
		});
	}
	setResizable(resizable: boolean) {
		return this.action<void>("setResizable", { resizable });
	}
	setEnabled(_enabled: boolean) {
		return Promise.resolve();
	}
	setMaximizable(_maximizable: boolean) {
		return Promise.resolve();
	}
	setMinimizable(_minimizable: boolean) {
		return Promise.resolve();
	}
	setClosable(_closable: boolean) {
		return Promise.resolve();
	}
	setTitle(title: string) {
		return this.action<void>("setTitle", { title });
	}
	maximize() {
		return this.action<void>("maximize");
	}
	unmaximize() {
		return this.action<void>("unmaximize");
	}
	toggleMaximize = async () =>
		(await this.isMaximized()) ? this.unmaximize() : this.maximize();
	minimize = () => this.action<void>("minimize");
	unminimize() {
		return this.action<void>("unminimize");
	}
	show() {
		return this.action<void>("show");
	}
	hide() {
		return this.action<void>("hide");
	}
	close = () => this.action<void>("close");
	destroy() {
		return this.action<void>("destroy");
	}
	setFocus() {
		return this.action<void>("focus");
	}
	setAlwaysOnTop(alwaysOnTop: boolean) {
		return this.action<void>("setAlwaysOnTop", { alwaysOnTop });
	}
	setContentProtected(enabled: boolean) {
		return this.action<void>("setContentProtected", { enabled });
	}
	setSize(size: Size) {
		return this.action<void>("setSize", {
			width: size.width,
			height: size.height,
			physical: size instanceof PhysicalSize,
		});
	}
	setMinSize(size: Size | null) {
		return this.action<void>("setMinimumSize", {
			width: size?.width,
			height: size?.height,
			physical: size instanceof PhysicalSize,
		});
	}
	setMaxSize(_size: Size | null) {
		return Promise.resolve();
	}
	setPosition(position: Position) {
		return this.action<void>("setPosition", {
			x: position.x,
			y: position.y,
			physical: position instanceof PhysicalPosition,
		});
	}
	setFullscreen(fullscreen: boolean) {
		return this.action<void>("setFullscreen", { fullscreen });
	}
	setEffects(_effects: Effects) {
		return Promise.resolve();
	}
	setProgressBar(options: { progress?: number; status?: ProgressBarStatus }) {
		const progress =
			options.status === ProgressBarStatus.None
				? null
				: options.progress === undefined
					? 2
					: options.progress / 100;
		return this.action<void>("setProgress", { progress });
	}
	setIcon(_icon: string | Uint8Array | ArrayBuffer | number[]) {
		return Promise.resolve();
	}
	setSkipTaskbar(skip: boolean) {
		return this.action<void>("setSkipTaskbar", { skip });
	}
	setCursorGrab(_grab: boolean) {
		return Promise.resolve();
	}
	setCursorVisible(_visible: boolean) {
		return Promise.resolve();
	}
	setCursorIcon(_icon: string) {
		return Promise.resolve();
	}
	setCursorPosition(position: Position) {
		return this.action<void>("setCursorPosition", {
			x: position.x,
			y: position.y,
		});
	}
	setIgnoreCursorEvents(ignore: boolean) {
		return this.action<void>("setIgnoreCursorEvents", { ignore });
	}
	startDragging() {
		return Promise.resolve();
	}
	startResizeDragging(_direction: string) {
		return Promise.resolve();
	}
	setBadgeCount(_count?: number) {
		return Promise.resolve();
	}
	setBadgeLabel(_label?: string) {
		return Promise.resolve();
	}
	setOverlayIcon(_icon?: unknown) {
		return Promise.resolve();
	}
	setShadow(_enable: boolean) {
		return Promise.resolve();
	}
	setTheme(_theme: Theme | null) {
		return Promise.resolve();
	}

	listen<T>(event: string, handler: (event: Event<T>) => void) {
		return listen(event, handler);
	}
	once<T>(event: string, handler: (event: Event<T>) => void) {
		return once(event, handler);
	}
	emit(event: string, payload?: unknown) {
		return emit(event, payload);
	}
	onResized(
		handler: (event: Event<PhysicalSize>) => void,
	): Promise<UnlistenFn> {
		return listen<{ width: number; height: number }>(
			"tauri://resize",
			(event) =>
				handler({
					...event,
					payload: new PhysicalSize(event.payload.width, event.payload.height),
				}),
		);
	}
	onMoved(
		handler: (event: Event<PhysicalPosition>) => void,
	): Promise<UnlistenFn> {
		return listen<{ x: number; y: number }>("tauri://move", (event) =>
			handler({
				...event,
				payload: new PhysicalPosition(event.payload.x, event.payload.y),
			}),
		);
	}
	onCloseRequested(
		handler: (event: CloseRequestedEvent) => void,
	): Promise<UnlistenFn> {
		return listen("tauri://close-requested", handler as never);
	}
	onDestroyed(handler: (event: Event<void>) => void): Promise<UnlistenFn> {
		return listen("tauri://destroyed", handler);
	}
	onFocusChanged(
		handler: (event: Event<boolean>) => void,
	): Promise<UnlistenFn> {
		return listen("tauri://focus", handler);
	}
	onScaleChanged(
		handler: (
			event: Event<{ scaleFactor: number; size: PhysicalSize }>,
		) => void,
	): Promise<UnlistenFn> {
		return listen<{
			scaleFactor: number;
			size: { width: number; height: number };
		}>("tauri://scale-change", (event) =>
			handler({
				...event,
				payload: {
					scaleFactor: event.payload.scaleFactor,
					size: new PhysicalSize(
						event.payload.size.width,
						event.payload.size.height,
					),
				},
			}),
		);
	}
	onThemeChanged(handler: (event: Event<Theme>) => void): Promise<UnlistenFn> {
		return listen("tauri://theme-changed", handler);
	}
	onDragDropEvent(
		handler: (event: Event<unknown>) => void,
	): Promise<UnlistenFn> {
		return listen("tauri://drag-drop", handler);
	}
}

export function getCurrentWindow() {
	return new Window(bridge().windowLabel);
}

export function getAllWindows() {
	return Window.getAll();
}

export async function currentMonitor() {
	return getCurrentWindow().currentMonitor();
}
export async function primaryMonitor() {
	return getCurrentWindow().primaryMonitor();
}
export async function monitorFromPoint(x: number, y: number) {
	return getCurrentWindow().monitorFromPoint(x, y);
}
export async function availableMonitors() {
	return getCurrentWindow().availableMonitors();
}

export { LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize };
