import type { ServiceWorkerRequest, ServiceWorkerResponse } from "./types";

export const wait = (durationMs: number) =>
	new Promise<void>((resolve) => {
		globalThis.setTimeout(resolve, durationMs);
	});

export const sendServiceWorkerMessage = (message: ServiceWorkerRequest) =>
	new Promise<ServiceWorkerResponse>((resolve, reject) => {
		chrome.runtime.sendMessage(message, (response) => {
			if (chrome.runtime.lastError) {
				reject(new Error(chrome.runtime.lastError.message ?? "Message failed"));
				return;
			}
			resolve(response as ServiceWorkerResponse);
		});
	});
