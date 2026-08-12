import { bridge, toIpcValue } from "./bridge";

let nextChannelId = 1;
const channels = new Map<number, Channel<unknown>>();

bridge().onChannel((message) => {
	const channel = channels.get(message.channelId);
	if (!channel) return;
	if (message.end) {
		channels.delete(message.channelId);
		return;
	}
	try {
		channel.onmessage?.(message.message);
	} catch (error) {
		channel.onerror?.(error);
	}
});

export class Channel<T = unknown> {
	id: number;
	onmessage?: (message: T) => void;
	onerror?: (error: unknown) => void;

	constructor(onmessage?: (message: T) => void) {
		this.id = nextChannelId++;
		this.onmessage = onmessage;
		channels.set(this.id, this as Channel<unknown>);
	}

	toJSON() {
		return `__CHANNEL__:${this.id}`;
	}
}

export async function invoke<T>(
	command: string,
	args?: Record<string, unknown>,
): Promise<T> {
	return bridge().invoke<T>(command, toIpcValue(args ?? {}));
}

export function convertFileSrc(filePath: string, protocol = "asset") {
	if (protocol !== "asset")
		return `${protocol}://localhost/${encodeURIComponent(filePath)}`;
	const bytes = new TextEncoder().encode(filePath);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `cap-asset://asset/${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

export function isTauri() {
	return false;
}
