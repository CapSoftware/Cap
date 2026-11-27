const channels = new Map<number, (value: unknown) => void>();

export function registerEditorChannel<T>(
	id: number,
	onmessage: (value: T) => void,
) {
	channels.set(id, (value) => onmessage(value as T));
}

export function emitEditorChannel(id: number, value: unknown) {
	channels.get(id)?.(value);
}

export function unregisterEditorChannel(id: number) {
	channels.delete(id);
}

export function serializeEditorChannel(value: unknown) {
	if (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "number" &&
		channels.has(value.id)
	) {
		return `__CHANNEL__:${value.id}`;
	}
	return value;
}

export function editorChannelId(value: unknown) {
	if (typeof value !== "string") return null;
	const match = /^__CHANNEL__:(\d+)$/.exec(value);
	return match ? Number(match[1]) : null;
}
