import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

export type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
};

export function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export type Stage = {
	container: HTMLDivElement;
	seen: string[];
	render: (node: ReactNode) => Promise<void>;
	close: () => Promise<void>;
};

export function openStage(): Stage {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	document.body.append(container);
	const root: Root = createRoot(container);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const seen: string[] = [];
	const observer = new MutationObserver(() => {
		seen.push(document.body.textContent ?? "");
	});
	observer.observe(document.body, {
		subtree: true,
		childList: true,
		characterData: true,
	});
	return {
		container,
		seen,
		render: (node) =>
			act(async () => {
				root.render(createElement(QueryClientProvider, { client }, node));
			}),
		close: async () => {
			observer.disconnect();
			await act(async () => root.unmount());
			container.remove();
			client.clear();
			vi.unstubAllGlobals();
		},
	};
}

export async function flush(ms = 20) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

export async function until(check: () => boolean, label: string) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await flush(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

export const text = () => document.body.textContent ?? "";

export function button(label: string) {
	const element = [...document.querySelectorAll("button")].find(
		(candidate) =>
			candidate.textContent?.trim() === label ||
			candidate.getAttribute("aria-label") === label,
	);
	if (!element) throw new Error(`Button not found: ${label}`);
	return element;
}

export async function click(element: Element) {
	await act(async () => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

export async function type(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	await act(async () => {
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

export async function chooseFiles(files: File[]) {
	const input = document.querySelector<HTMLInputElement>("input[type=file]");
	if (!input) throw new Error("File input not found");
	Object.defineProperty(input, "files", { value: files, configurable: true });
	await act(async () => {
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

export function stubStorageUploads(options: { finish?: boolean } = {}) {
	const requests: string[] = [];
	class FakeXhr {
		status = 200;
		upload: { onprogress: ((event: { loaded: number }) => void) | null } = {
			onprogress: null,
		};
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onabort: (() => void) | null = null;
		open(_method: string, url: string) {
			requests.push(url);
		}
		send(body: Blob) {
			if (options.finish === false) return;
			setTimeout(() => {
				this.upload.onprogress?.({ loaded: body.size });
				this.onload?.();
			}, 0);
		}
		abort() {
			this.onabort?.();
		}
		getResponseHeader(name: string) {
			return name === "ETag" ? '"etag"' : null;
		}
	}
	vi.stubGlobal("XMLHttpRequest", FakeXhr);
	return requests;
}

export function stubVideoProbe() {
	vi.stubGlobal("URL", {
		...URL,
		createObjectURL: () => "blob:probe",
		revokeObjectURL: () => undefined,
	});
	const create = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation(((
		tag: string,
		options?: ElementCreationOptions,
	) => {
		if (tag !== "video") return create(tag, options);
		const probe = {
			duration: 12,
			videoWidth: 1280,
			videoHeight: 720,
			preload: "",
			muted: false,
			onloadedmetadata: null as (() => void) | null,
			onerror: null as (() => void) | null,
			removeAttribute: () => undefined,
			load: () => undefined,
			set src(_value: string) {
				queueMicrotask(() => probe.onloadedmetadata?.());
			},
		};
		return probe;
	}) as typeof document.createElement);
}
