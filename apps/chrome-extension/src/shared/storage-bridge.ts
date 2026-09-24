export type StorageBridgeRequest =
	| {
			target: "storage-bridge";
			type: "get";
			area: "local" | "session";
			keys: string[];
	  }
	| {
			target: "storage-bridge";
			type: "set";
			area: "local" | "session";
			items: Record<string, unknown>;
	  }
	| {
			target: "storage-bridge";
			type: "remove";
			area: "local" | "session";
			keys: string[] | string;
	  };

export type StorageBridgeResponse =
	| { ok: true; items?: Record<string, unknown> }
	| { ok: false; error: string };

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string");

export const isStorageBridgeRequest = (
	message: unknown,
): message is StorageBridgeRequest => {
	if (!message || typeof message !== "object") return false;
	const candidate = message as Record<string, unknown>;
	if (
		candidate.target !== "storage-bridge" ||
		(candidate.area !== "local" && candidate.area !== "session")
	) {
		return false;
	}
	if (candidate.type === "get") return isStringArray(candidate.keys);
	if (candidate.type === "set") {
		return (
			!!candidate.items &&
			typeof candidate.items === "object" &&
			!Array.isArray(candidate.items)
		);
	}
	if (candidate.type === "remove") {
		return typeof candidate.keys === "string" || isStringArray(candidate.keys);
	}
	return false;
};

export const isTrustedOffscreenStorageSender = (
	sender: Pick<chrome.runtime.MessageSender, "id" | "tab" | "url">,
	extensionId: string,
	offscreenUrl: string,
) =>
	sender.id === extensionId &&
	sender.url === offscreenUrl &&
	sender.tab === undefined;

const storageError = () =>
	chrome.runtime?.lastError?.message ?? "Extension storage request failed";

export const executeStorageBridgeRequest = (
	request: StorageBridgeRequest,
): Promise<Extract<StorageBridgeResponse, { ok: true }>> => {
	const area = chrome.storage?.[request.area];
	if (!area)
		return Promise.reject(new Error("Extension storage is unavailable"));
	return new Promise((resolve, reject) => {
		if (request.type === "get") {
			area.get(request.keys, (items) => {
				if (chrome.runtime?.lastError) reject(new Error(storageError()));
				else resolve({ ok: true, items });
			});
			return;
		}
		if (request.type === "set") {
			area.set(request.items, () => {
				if (chrome.runtime?.lastError) reject(new Error(storageError()));
				else resolve({ ok: true });
			});
			return;
		}
		area.remove(request.keys, () => {
			if (chrome.runtime?.lastError) reject(new Error(storageError()));
			else resolve({ ok: true });
		});
	});
};

export const requestStorage = (
	request: StorageBridgeRequest,
): Promise<Extract<StorageBridgeResponse, { ok: true }>> => {
	if (chrome.storage?.[request.area]) {
		return executeStorageBridgeRequest(request);
	}
	return new Promise((resolve, reject) => {
		chrome.runtime.sendMessage(request, (response: unknown) => {
			if (chrome.runtime.lastError) {
				reject(new Error(storageError()));
				return;
			}
			if (!response || typeof response !== "object" || !("ok" in response)) {
				reject(new Error("Extension storage bridge did not respond"));
				return;
			}
			const result = response as StorageBridgeResponse;
			if (!result.ok) {
				reject(new Error(result.error));
				return;
			}
			resolve(result);
		});
	});
};
