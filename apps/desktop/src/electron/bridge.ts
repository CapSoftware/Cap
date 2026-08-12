export interface CapElectronBridge {
	windowLabel: string;
	initialization: unknown;
	os: { arch: string; platform: string; type: string; version: string };
	invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
	native<T>(operation: string, payload?: Record<string, unknown>): Promise<T>;
	emit(event: string, payload?: unknown): void;
	onEvent(listener: (message: BridgeEvent) => void): () => void;
	onChannel(listener: (message: BridgeChannelMessage) => void): () => void;
}

export interface BridgeEvent {
	type: "event";
	event: string;
	payload: unknown;
	target?: string;
}

export interface BridgeChannelMessage {
	type: "channel";
	channelId: number;
	index: number;
	message?: unknown;
	end: boolean;
}

declare global {
	interface Window {
		capElectron: CapElectronBridge;
	}
}

export function bridge() {
	if (!window.capElectron) throw new Error("Cap Electron preload bridge is unavailable");
	return window.capElectron;
}

export function toIpcValue<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export function native<T>(operation: string, payload?: Record<string, unknown>) {
	return bridge().native<T>(operation, toIpcValue(payload ?? {}));
}
