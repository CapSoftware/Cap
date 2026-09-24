import { afterEach, expect, test, vi } from "vitest";
import { EditorHostBridge } from "../../app/s/[videoId]/edit/studio/editor-host";
import { uploadWebEditorExport } from "../../lib/editor-export-upload-client";

vi.mock("@/lib/editor-export-upload-client", () => ({
	uploadWebEditorExport: vi.fn(async () => undefined),
}));

const ticket = "a".repeat(43);
const credentials = {
	commands: { url: "ws://127.0.0.1:1234/commands", ticket },
	events: { url: "ws://127.0.0.1:1234/events", ticket },
	audio: { url: "ws://127.0.0.1:1234/audio", ticket },
	frames: { url: "ws://127.0.0.1:1234/frames", ticket },
};

function frame(status: "ready" | "error" | null = "ready") {
	const postMessage = vi.fn(
		(_message: unknown, _origin: string, ports?: MessagePort[]) => {
			if (status) ports?.[0]?.postMessage({ kind: "mount", status });
		},
	);
	return {
		postMessage,
		iframe: {
			contentWindow: { postMessage },
		} as unknown as HTMLIFrameElement,
	};
}

afterEach(() => vi.unstubAllGlobals());

test("disposing during ticket fetch never attaches the editor frame", async () => {
	let resolveFetch: (response: Response) => void = () => undefined;
	const pendingFetch = new Promise<Response>((resolve) => {
		resolveFetch = resolve;
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(() => pendingFetch),
	);
	const { iframe, postMessage } = frame();
	const bridge = new EditorHostBridge(
		"video",
		"session",
		"user",
		vi.fn(),
		vi.fn(),
	);
	const connecting = bridge.connect(iframe);
	bridge.dispose();
	resolveFetch(Response.json(credentials));
	await expect(connecting).rejects.toThrow("Editor bridge is closed");
	expect(postMessage).not.toHaveBeenCalled();
});

test("disposing during socket negotiation closes every pending connection", async () => {
	const sockets: PendingSocket[] = [];
	class PendingSocket extends EventTarget {
		protocol = "cap-editor-v1";
		closed = false;
		constructor(_url: string, _protocols: string[]) {
			super();
			sockets.push(this);
		}
		close() {
			this.closed = true;
		}
	}
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json(credentials)),
	);
	vi.stubGlobal("WebSocket", PendingSocket);
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	const { iframe, postMessage } = frame();
	const bridge = new EditorHostBridge(
		"video",
		"session",
		"user",
		vi.fn(),
		vi.fn(),
	);
	const connecting = bridge.connect(iframe);
	await vi.waitFor(() => expect(sockets).toHaveLength(3));
	bridge.dispose();
	await expect(connecting).rejects.toThrow("Editor bridge is closed");
	expect(sockets.every((socket) => socket.closed)).toBe(true);
	expect(postMessage).not.toHaveBeenCalled();
});

test("a failed Solid mount rejects the web editor connection", async () => {
	const sockets: Array<{ closed: boolean }> = [];
	class OpenSocket extends EventTarget {
		protocol = "cap-editor-v1";
		closed = false;
		constructor(_url: string, _protocols: string[]) {
			super();
			sockets.push(this);
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}
		close() {
			this.closed = true;
		}
	}
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json(credentials)),
	);
	vi.stubGlobal("WebSocket", OpenSocket);
	vi.stubGlobal("window", {
		setTimeout,
		clearTimeout,
		location: { origin: "http://127.0.0.1:3000" },
	});
	const { iframe } = frame("error");
	const bridge = new EditorHostBridge(
		"video",
		"session",
		"user",
		vi.fn(),
		vi.fn(),
	);
	await expect(bridge.connect(iframe)).rejects.toThrow("Editor could not load");
	bridge.dispose();
	expect(sockets).toHaveLength(3);
	expect(sockets.every((socket) => socket.closed)).toBe(true);
});

test("desktop autosave is acknowledged only after the persistent web API saves it", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	let savedAt = "first-revision";
	const save = vi.fn(async () =>
		Response.json({ saved: true, savedAt: "second-revision" }),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			return url.endsWith("/tickets") ? Response.json(credentials) : save();
		}),
	);
	class OpenSocket extends EventTarget {
		protocol = "cap-editor-v1";
		readyState = 1;
		constructor(_url: string, _protocols: string[]) {
			super();
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}
		close() {
			this.readyState = 3;
		}
		send() {
			throw new Error("Native command socket should not handle project saves");
		}
	}
	vi.stubGlobal("WebSocket", OpenSocket);
	vi.stubGlobal("window", {
		setTimeout,
		clearTimeout,
		location: { origin: "http://127.0.0.1:3000" },
	});
	const { iframe, postMessage } = frame();
	const bridge = new EditorHostBridge(
		"video",
		"session",
		"user",
		vi.fn(),
		vi.fn(),
		undefined,
		undefined,
		undefined,
		false,
		undefined,
		(nextSavedAt) => {
			savedAt = nextSavedAt;
		},
		() => savedAt,
	);
	await bridge.connect(iframe);
	const port = postMessage.mock.calls[0]?.[2]?.[0] as MessagePort;
	const reply = new Promise<unknown>((resolve) => {
		port.onmessage = (event) => resolve(event.data);
		port.start();
	});
	port.postMessage({
		kind: "invoke",
		id: 7,
		name: "setProjectConfig",
		args: [{ camera: { mirror: true } }],
	});
	expect(await reply).toEqual({ kind: "result", id: 7, value: null });
	expect(save).toHaveBeenCalledOnce();
	expect(requests[1]?.url).toBe("/api/editor/sessions/session/config");
	expect(requests[1]?.init?.method).toBe("PUT");
	expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
		videoId: "video",
		config: { camera: { mirror: true } },
		expectedSavedAt: "first-revision",
	});
	expect(savedAt).toBe("second-revision");
	const nextReply = new Promise<unknown>((resolve) => {
		port.onmessage = (event) => resolve(event.data);
	});
	port.postMessage({
		kind: "invoke",
		id: 8,
		name: "setProjectConfig",
		args: [{ camera: { mirror: false } }, true],
	});
	expect(await nextReply).toEqual({ kind: "result", id: 8, value: null });
	expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
		videoId: "video",
		config: { camera: { mirror: false } },
		expectedSavedAt: "second-revision",
		preserveExistingPaidCaptions: true,
	});
	port.close();
	bridge.dispose();
});

async function connectedExportHost(
	request: (url: string, init?: RequestInit) => Promise<Response>,
	captionsEnabled = false,
	onUpgrade?: () => void,
	parentEvents = false,
) {
	vi.stubGlobal(
		"fetch",
		vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			return url.endsWith("/tickets")
				? Promise.resolve(Response.json(credentials))
				: request(url, init);
		}),
	);
	class OpenSocket extends EventTarget {
		protocol = "cap-editor-v1";
		readyState = 1;
		constructor(_url: string, _protocols: string[]) {
			super();
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}
		close() {
			this.readyState = 3;
		}
		send() {
			throw new Error(
				"Native command socket should not handle web export jobs",
			);
		}
	}
	vi.stubGlobal("WebSocket", OpenSocket);
	const browserWindow = {
		setTimeout,
		clearTimeout,
		location: { origin: "http://127.0.0.1:3000" },
	};
	vi.stubGlobal(
		"window",
		parentEvents
			? Object.assign(new EventTarget(), browserWindow)
			: browserWindow,
	);
	if (parentEvents)
		vi.stubGlobal(
			"document",
			Object.assign(new EventTarget(), { hidden: false }),
		);
	const { iframe, postMessage } = frame();
	const onClose = vi.fn();
	const bridge = new EditorHostBridge(
		"video",
		"session",
		"user",
		onClose,
		vi.fn(),
		undefined,
		undefined,
		undefined,
		captionsEnabled,
		onUpgrade,
	);
	await bridge.connect(iframe);
	const port = postMessage.mock.calls[0]?.[2]?.[0] as MessagePort;
	port.start();
	return { bridge, port, onClose };
}

test("returning to the web page sends the refreshed caption plan to Studio", async () => {
	const planRequests: string[] = [];
	const { bridge, port } = await connectedExportHost(
		async (url) => {
			if (!url.includes("/plan?")) throw new Error(`Unexpected request ${url}`);
			planRequests.push(url);
			return Response.json({ pro: true });
		},
		false,
		undefined,
		true,
	);
	const plans: boolean[] = [];
	port.onmessage = (event: MessageEvent<unknown>) => {
		const message = event.data;
		if (
			typeof message === "object" &&
			message !== null &&
			"kind" in message &&
			message.kind === "event" &&
			"name" in message &&
			message.name === "editorCaptionPlan" &&
			"payload" in message &&
			typeof message.payload === "boolean"
		) {
			plans.push(message.payload);
		}
	};
	try {
		window.dispatchEvent(new Event("focus"));
		await vi.waitFor(() => expect(plans).toEqual([true]));
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.waitFor(() => expect(plans).toEqual([true, true]));
		expect(planRequests).toHaveLength(2);
	} finally {
		port.close();
		bridge.dispose();
	}
});

test("overlapping host plan requests still deliver the latest Studio entitlement", async () => {
	const replies: Array<(response: Response) => void> = [];
	const { bridge, port } = await connectedExportHost(
		async (url) => {
			if (!url.includes("/plan?")) throw new Error(`Unexpected request ${url}`);
			return new Promise<Response>((resolve) => replies.push(resolve));
		},
		false,
		undefined,
		true,
	);
	const plans: boolean[] = [];
	const commandResults: boolean[] = [];
	port.onmessage = (event: MessageEvent<unknown>) => {
		const message = event.data;
		if (typeof message !== "object" || message === null) return;
		if (
			"kind" in message &&
			message.kind === "event" &&
			"name" in message &&
			message.name === "editorCaptionPlan" &&
			"payload" in message &&
			typeof message.payload === "boolean"
		) {
			plans.push(message.payload);
		} else if (
			"kind" in message &&
			message.kind === "result" &&
			"id" in message &&
			message.id === 73 &&
			"value" in message &&
			typeof message.value === "boolean"
		) {
			commandResults.push(message.value);
		}
	};
	try {
		window.dispatchEvent(new Event("focus"));
		await vi.waitFor(() => expect(replies).toHaveLength(1));
		port.postMessage({
			kind: "invoke",
			id: 73,
			name: "checkUpgradedAndUpdate",
			args: [],
		});
		await vi.waitFor(() => expect(replies).toHaveLength(2));
		replies[1]?.(Response.json({ pro: true }));
		await vi.waitFor(() => expect(plans).toEqual([true]));
		await vi.waitFor(() => expect(commandResults).toEqual([true]));
		replies[0]?.(Response.json({ pro: false }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(plans).toEqual([true]);
	} finally {
		port.close();
		bridge.dispose();
	}
});

test("a failed newer plan request does not discard a successful Studio refresh", async () => {
	const replies: Array<(response: Response) => void> = [];
	const { bridge, port } = await connectedExportHost(
		async (url) => {
			if (!url.includes("/plan?")) throw new Error(`Unexpected request ${url}`);
			return new Promise<Response>((resolve) => replies.push(resolve));
		},
		false,
		undefined,
		true,
	);
	const plans: boolean[] = [];
	let newerRequestFailed = false;
	port.onmessage = (event: MessageEvent<unknown>) => {
		const message = event.data;
		if (typeof message !== "object" || message === null) return;
		if (
			"kind" in message &&
			message.kind === "event" &&
			"name" in message &&
			message.name === "editorCaptionPlan" &&
			"payload" in message &&
			typeof message.payload === "boolean"
		) {
			plans.push(message.payload);
		} else if (
			"kind" in message &&
			message.kind === "error" &&
			"id" in message &&
			message.id === 74
		) {
			newerRequestFailed = true;
		}
	};
	try {
		window.dispatchEvent(new Event("focus"));
		await vi.waitFor(() => expect(replies).toHaveLength(1));
		port.postMessage({
			kind: "invoke",
			id: 74,
			name: "checkUpgradedAndUpdate",
			args: [],
		});
		await vi.waitFor(() => expect(replies).toHaveLength(2));
		replies[1]?.(new Response("Unavailable", { status: 503 }));
		await vi.waitFor(() => expect(newerRequestFailed).toBe(true));
		replies[0]?.(Response.json({ pro: true }));
		await vi.waitFor(() => expect(plans).toEqual([true]));
		expect(Reflect.get(bridge, "captionsEnabled")).toBe(true);
	} finally {
		port.close();
		bridge.dispose();
	}
});

test("caption cache conflicts retain the shared bridge's full-payload retry", async () => {
	const { bridge, port } = await connectedExportHost(
		async () => new Response("Conflict", { status: 409 }),
	);
	const save = async (id: number, config: Record<string, unknown>) => {
		const reply = new Promise<{ kind: string; error?: string }>((resolve) => {
			port.onmessage = (event) => resolve(event.data);
		});
		port.postMessage({
			kind: "invoke",
			id,
			name: "setProjectConfig",
			args: [config],
		});
		return reply;
	};
	expect(
		await save(21, { webCaptionRef: "caption-cache", camera: {} }),
	).toEqual(
		expect.objectContaining({
			kind: "error",
			error: "Caption payload cache is unavailable",
		}),
	);
	expect(await save(22, { captions: { segments: [] }, camera: {} })).toEqual(
		expect.objectContaining({
			kind: "error",
			error:
				"Editor changed in another tab or caption data is unavailable. Reload to continue.",
		}),
	);
	port.close();
	bridge.dispose();
});

test("recording title saves through the owned web session", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	let conflict = false;
	const { bridge, port } = await connectedExportHost(async (url, init) => {
		requests.push({ url, init });
		return conflict
			? new Response("Conflict", { status: 409 })
			: Response.json({ saved: true });
	});
	const title = async (id: number, prettyName: string) => {
		const reply = new Promise<unknown>((resolve) => {
			port.onmessage = (event) => resolve(event.data);
		});
		port.postMessage({
			kind: "invoke",
			id,
			name: "setPrettyName",
			args: [prettyName],
		});
		return reply;
	};
	try {
		expect(await title(1, "Renamed recording")).toEqual({
			kind: "result",
			id: 1,
			value: null,
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("/api/editor/sessions/session/meta");
		expect(requests[0]?.init?.method).toBe("PUT");
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			videoId: "video",
			prettyName: "Renamed recording",
		});
		expect(await title(2, "Tiny")).toEqual({
			kind: "error",
			id: 2,
			error: "Recording title must be 5 to 100 characters",
		});
		expect(requests).toHaveLength(1);
		conflict = true;
		expect(await title(3, "Another recording")).toEqual({
			kind: "error",
			id: 3,
			error: "Recording title changed in another editor",
		});
	} finally {
		port.close();
		bridge.dispose();
	}
});

test("both editor folder actions download an owned recording bundle", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const downloadUrl = `https://media.cap.so/editor/sessions/session/project-bundle/download?ticket=${ticket}`;
	const { bridge, port } = await connectedExportHost(async (url, init) => {
		requests.push({ url, init });
		return Response.json({ url: downloadUrl });
	});
	const click = vi.fn();
	const remove = vi.fn();
	const append = vi.fn();
	const link = { href: "", rel: "", download: "", click, remove };
	vi.stubGlobal("document", {
		createElement: vi.fn(() => link),
		body: { append },
	});
	const invoke = async (id: number, path: string) => {
		const reply = new Promise<unknown>((resolve) => {
			port.onmessage = (event) => resolve(event.data);
		});
		port.postMessage({
			kind: "invoke",
			id,
			name: "tauri:download_editor_bundle",
			args: [{ path }],
		});
		return reply;
	};
	try {
		for (const [id, path] of [
			[1, "cap-web-editor://session/session/"],
			[2, "cap-web-editor://session/session"],
		] as const) {
			expect(await invoke(id, path)).toEqual({
				kind: "result",
				id,
				value: null,
			});
		}
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request.url).toBe(
				"/api/editor/sessions/session/project-bundle/download-ticket",
			);
			expect(request.init?.method).toBe("POST");
			expect(JSON.parse(String(request.init?.body))).toEqual({
				videoId: "video",
			});
		}
		expect(click).toHaveBeenCalledTimes(2);
		expect(link.href).toBe(downloadUrl);
		expect(link.download).toBe("Cap Recording.capbundle");
		expect(append).toHaveBeenCalledTimes(2);
		expect(remove).toHaveBeenCalledTimes(2);
		expect(await invoke(3, "cap-web-editor://session/other")).toEqual({
			kind: "error",
			id: 3,
			error: "Editor bundle request was invalid",
		});
		expect(requests).toHaveLength(2);
	} finally {
		port.close();
		bridge.dispose();
	}
});

test("browser Studio reprepares export workers after Cap Pro changes without restarting local playback", async () => {
	let pro = true;
	let now = Date.now();
	let preparations = 0;
	const released: string[] = [];
	const downloaded: string[] = [];
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	vi.stubGlobal("window", {
		setTimeout,
		clearTimeout,
		location: { origin: "http://127.0.0.1:3000" },
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/editor/videos/video/plan")
				return Response.json({ pro });
			if (url === "/api/editor/preparations" && init?.method === "POST") {
				preparations++;
				return Response.json({
					id: `prep-${preparations}`,
					status: "preparing",
				});
			}
			if (
				url.startsWith("/api/editor/preparations/prep-") &&
				init?.method !== "DELETE"
			) {
				const number = url.match(/prep-(\d+)/)?.[1];
				return Response.json({
					status: "ready",
					sessionId: `worker-${number}`,
				});
			}
			if (
				url.startsWith("/api/editor/sessions/worker-") &&
				init?.method === "DELETE"
			) {
				released.push(url);
				return Response.json({ closed: true });
			}
			if (
				url.endsWith("/project-bundle/download-ticket") &&
				init?.method === "POST"
			) {
				const number = url.match(/worker-(\d+)/)?.[1];
				return Response.json({
					url: `https://media.cap.so/editor/sessions/worker-${number}/project-bundle/download?ticket=${ticket}`,
				});
			}
			throw new Error(`Unexpected editor request ${url}`);
		}),
	);
	vi.stubGlobal("document", {
		createElement: vi.fn(() => ({
			href: "",
			rel: "",
			download: "",
			click() {
				downloaded.push(this.href);
			},
			remove: vi.fn(),
		})),
		body: { append: vi.fn() },
	});
	const { iframe, postMessage } = frame();
	const bridge = new EditorHostBridge(
		"video",
		"session",
		"user",
		vi.fn(),
		vi.fn(),
		undefined,
		undefined,
		undefined,
		true,
		undefined,
		undefined,
		() => "saved-revision",
		true,
	);
	try {
		await bridge.connect(iframe);
		const port = postMessage.mock.calls[0]?.[2]?.[0] as MessagePort;
		port.start();
		const download = async (id: number) => {
			const reply = new Promise<unknown>((resolve) => {
				port.onmessage = (event) => resolve(event.data);
			});
			port.postMessage({
				kind: "invoke",
				id,
				name: "tauri:download_editor_bundle",
				args: [{ path: "cap-web-editor://session/session" }],
			});
			return reply;
		};
		for (const [id, plan] of [
			[1, true],
			[2, false],
			[3, true],
		] as const) {
			pro = plan;
			if (id > 1) now += 31_000;
			expect(await download(id)).toEqual({ kind: "result", id, value: null });
		}
		expect(preparations).toBe(3);
		expect(released).toEqual([
			"/api/editor/sessions/worker-1?videoId=video",
			"/api/editor/sessions/worker-2?videoId=video",
		]);
		expect(downloaded).toEqual(
			[1, 2, 3].map(
				(number) =>
					`https://media.cap.so/editor/sessions/worker-${number}/project-bundle/download?ticket=${ticket}`,
			),
		);
		port.close();
	} finally {
		bridge.dispose();
		clock.mockRestore();
	}
});

test("a plan change cannot release a worker during another browser Studio operation", async () => {
	let planReads = 0;
	let preparations = 0;
	let bundleTicketRequests = 0;
	let resolvePreparation: (response: Response) => void = () => undefined;
	let resolveChangedPlan: (response: Response) => void = () => undefined;
	let resolveBundleTicket: (response: Response) => void = () => undefined;
	const preparationReady = new Promise<Response>((resolve) => {
		resolvePreparation = resolve;
	});
	const changedPlan = new Promise<Response>((resolve) => {
		resolveChangedPlan = resolve;
	});
	const bundleTicket = new Promise<Response>((resolve) => {
		resolveBundleTicket = resolve;
	});
	const released: string[] = [];
	const downloaded: string[] = [];
	vi.stubGlobal("window", {
		setTimeout,
		clearTimeout,
		location: { origin: "http://127.0.0.1:3000" },
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/editor/videos/video/plan") {
				planReads++;
				return planReads === 3 ? changedPlan : Response.json({ pro: true });
			}
			if (url === "/api/editor/preparations" && init?.method === "POST") {
				preparations++;
				return Response.json({ id: "prep-1", status: "preparing" });
			}
			if (url === "/api/editor/preparations/prep-1?videoId=video")
				return preparationReady;
			if (
				url === "/api/editor/sessions/worker-1?videoId=video" &&
				init?.method === "DELETE"
			) {
				released.push(url);
				return Response.json({ closed: true });
			}
			if (
				url ===
					"/api/editor/sessions/worker-1/project-bundle/download-ticket" &&
				init?.method === "POST"
			) {
				bundleTicketRequests++;
				return bundleTicket;
			}
			throw new Error(`Unexpected editor request ${url}`);
		}),
	);
	vi.stubGlobal("document", {
		createElement: vi.fn(() => ({
			href: "",
			rel: "",
			download: "",
			click() {
				downloaded.push(this.href);
			},
			remove: vi.fn(),
		})),
		body: { append: vi.fn() },
	});
	const { iframe, postMessage } = frame();
	const bridge = new EditorHostBridge(
		"video",
		"session",
		"user",
		vi.fn(),
		vi.fn(),
		undefined,
		undefined,
		undefined,
		true,
		undefined,
		undefined,
		() => "saved-revision",
		true,
	);
	try {
		await bridge.connect(iframe);
		const port = postMessage.mock.calls[0]?.[2]?.[0] as MessagePort;
		const replies: Array<{ kind: string; id: number; error?: string }> = [];
		port.onmessage = (event) => replies.push(event.data);
		port.start();
		for (const id of [1, 2]) {
			port.postMessage({
				kind: "invoke",
				id,
				name: "tauri:download_editor_bundle",
				args: [{ path: "cap-web-editor://session/session" }],
			});
		}
		await vi.waitFor(() => expect(planReads).toBe(1));
		await vi.waitFor(() => expect(preparations).toBe(1));
		resolvePreparation(
			Response.json({ status: "ready", sessionId: "worker-1" }),
		);
		await vi.waitFor(() => expect(bundleTicketRequests).toBe(1));
		await vi.waitFor(() => expect(planReads).toBe(3));
		resolveChangedPlan(Response.json({ pro: false }));
		await vi.waitFor(() =>
			expect(replies).toContainEqual({
				kind: "error",
				id: 2,
				error: "Finish the current editor operation before exporting new edits",
			}),
		);
		expect(released).toEqual([]);
		resolveBundleTicket(
			Response.json({
				url: `https://media.cap.so/editor/sessions/worker-1/project-bundle/download?ticket=${ticket}`,
			}),
		);
		await vi.waitFor(() =>
			expect(replies).toContainEqual({ kind: "result", id: 1, value: null }),
		);
		expect(downloaded).toHaveLength(1);
		expect(released).toEqual([]);
		port.close();
	} finally {
		bridge.dispose();
	}
});

test("canceling an export estimate during worker startup never starts native rendering", async () => {
	let resolvePreparation: (response: Response) => void = () => undefined;
	const preparation = new Promise<Response>((resolve) => {
		resolvePreparation = resolve;
	});
	const requests: string[] = [];
	const sends: string[] = [];
	vi.stubGlobal("window", {
		setTimeout,
		clearTimeout,
		location: { origin: "http://127.0.0.1:3000" },
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			requests.push(url);
			if (url === "/api/editor/videos/video/plan")
				return Response.json({ pro: false });
			if (url === "/api/editor/preparations" && init?.method === "POST")
				return preparation;
			if (url === "/api/editor/preparations/prep-1?videoId=video")
				return Response.json({ status: "ready", sessionId: "worker-1" });
			if (
				url === "/api/editor/sessions/worker-1?videoId=video" &&
				init?.method === "DELETE"
			)
				return Response.json({ closed: true });
			if (
				url === "/api/editor/sessions/worker-1/tickets" &&
				init?.method === "POST"
			)
				return Response.json(credentials);
			throw new Error(`Unexpected editor request ${url}`);
		}),
	);
	class OpenSocket extends EventTarget {
		protocol = "cap-editor-v1";
		readyState = 1;
		constructor(_url: string, _protocols: string[]) {
			super();
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}
		close() {
			this.readyState = 3;
		}
		send(value: string) {
			sends.push(value);
		}
	}
	vi.stubGlobal("WebSocket", OpenSocket);
	const { iframe, postMessage } = frame();
	const bridge = new EditorHostBridge(
		"video",
		"session",
		"user",
		vi.fn(),
		vi.fn(),
		undefined,
		undefined,
		undefined,
		false,
		undefined,
		undefined,
		() => null,
		true,
	);
	try {
		await bridge.connect(iframe);
		const port = postMessage.mock.calls[0]?.[2]?.[0] as MessagePort;
		const replies: Array<{ kind: string; id: number; error?: string }> = [];
		port.onmessage = (event) => replies.push(event.data);
		port.start();
		port.postMessage({
			kind: "invoke",
			id: 51,
			name: "getExportEstimates",
			args: ["cap-web-editor://session/session", {}, 12],
		});
		await vi.waitFor(() =>
			expect(requests).toContain("/api/editor/preparations"),
		);
		port.postMessage({
			kind: "invoke",
			id: 52,
			name: "cancelExportEstimates",
			args: [],
		});
		await vi.waitFor(() =>
			expect(replies).toContainEqual({ kind: "result", id: 52, value: null }),
		);
		resolvePreparation(Response.json({ id: "prep-1", status: "preparing" }));
		await vi.waitFor(() =>
			expect(replies).toContainEqual({
				kind: "error",
				id: 51,
				error: "Editor export estimate was canceled",
			}),
		);
		expect(sends).toEqual([]);
		expect(requests).not.toContain("/api/editor/sessions/worker-1/tickets");
		port.close();
	} finally {
		bridge.dispose();
	}
});

test("chosen desktop wallpaper uploads as an image and returns its portable path", async () => {
	const path = "content/images/22222222-2222-4222-8222-222222222222.jpg";
	const key = `user/video/editor-assets/images/${path.slice("content/images/".length)}`;
	const assetUrl = "/api/editor/sessions/session/assets";
	const uploadUrl = "http://127.0.0.1:1234/upload-wallpaper";
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const { bridge, port } = await connectedExportHost(async (url, init) => {
		requests.push({ url, init });
		if (url === assetUrl && init?.method === "POST") {
			return Response.json({
				key,
				path,
				upload: { type: "put", url: uploadUrl, headers: {} },
			});
		}
		if (url === uploadUrl && init?.method === "PUT")
			return new Response(null, { status: 200 });
		if (url === assetUrl && init?.method === "PUT") {
			return Response.json({
				path,
				name: "wallpaper.jpg",
				width: 64,
				height: 64,
			});
		}
		if (url === `${assetUrl}?videoId=video` && !init?.method)
			return Response.json({ path });
		throw new Error(`Unexpected wallpaper request: ${url}`);
	});
	try {
		const reply = new Promise<unknown>((resolve) => {
			port.onmessage = (event) => resolve(event.data);
		});
		port.postMessage({
			kind: "invoke",
			id: 52,
			name: "importCurrentDesktopBackground",
			args: [
				new File([new Uint8Array([1, 2, 3])], "wallpaper.jpg", {
					type: "image/jpeg",
				}),
			],
		});
		expect(await reply).toEqual({ kind: "result", id: 52, value: path });
		const storedReply = new Promise<unknown>((resolve) => {
			port.onmessage = (event) => resolve(event.data);
		});
		port.postMessage({
			kind: "invoke",
			id: 53,
			name: "tauri:webEditorStoredDesktopBackground",
			args: [undefined],
		});
		expect(await storedReply).toEqual({ kind: "result", id: 53, value: path });
		expect(
			requests.map((request) => [request.url, request.init?.method]),
		).toEqual([
			[assetUrl, "POST"],
			[uploadUrl, "PUT"],
			[assetUrl, "PUT"],
			[`${assetUrl}?videoId=video`, undefined],
		]);
		expect(JSON.parse(String(requests[0]?.init?.body)).fileName).toBe(
			"current-desktop-background.jpg",
		);
		expect(JSON.parse(String(requests[2]?.init?.body)).fileName).toBe(
			"current-desktop-background.jpg",
		);
	} finally {
		port.close();
		bridge.dispose();
	}
});

test("deleting a recording uses the owned video API and closes to the dashboard", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const { bridge, port, onClose } = await connectedExportHost(
		async (url, init) => {
			requests.push({ url, init });
			return Response.json({ deleted: true });
		},
	);
	try {
		const reply = new Promise<unknown>((resolve) => {
			port.onmessage = (event) => resolve(event.data);
		});
		port.postMessage({
			kind: "invoke",
			id: 43,
			name: "editorDeleteProject",
			args: [],
		});
		expect(await reply).toEqual({ kind: "result", id: 43, value: null });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("/api/video/delete?videoId=video");
		expect(requests[0]?.init?.method).toBe("DELETE");
		expect(onClose).toHaveBeenCalledWith("deleted");
	} finally {
		port.close();
		bridge.dispose();
	}
});

test("a failed recording deletion keeps the editor open", async () => {
	const { bridge, port, onClose } = await connectedExportHost(
		async () => new Response("Storage unavailable", { status: 503 }),
	);
	try {
		const reply = new Promise<unknown>((resolve) => {
			port.onmessage = (event) => resolve(event.data);
		});
		port.postMessage({
			kind: "invoke",
			id: 44,
			name: "editorDeleteProject",
			args: [],
		});
		expect(await reply).toEqual({
			kind: "error",
			id: 44,
			error: "Recording could not be deleted",
		});
		expect(onClose).not.toHaveBeenCalled();
	} finally {
		port.close();
		bridge.dispose();
	}
});

test("web editor metadata exposes the recording's existing share link", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json(credentials)),
	);
	class MetaSocket extends EventTarget {
		static OPEN = 1;
		protocol = "cap-editor-v1";
		readyState = 1;
		onmessage: ((event: MessageEvent<string>) => void) | null = null;
		constructor(_url: string, _protocols: string[]) {
			super();
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}
		close() {
			this.readyState = 3;
		}
		send(payload: string) {
			const request = JSON.parse(payload) as { id: number; name: string };
			expect(["getEditorMeta", "getRecordingMetaByPath"]).toContain(
				request.name,
			);
			queueMicrotask(() =>
				this.onmessage?.({
					data: JSON.stringify({
						kind: "result",
						id: request.id,
						value: { pretty_name: "Shared recording", sharing: null },
					}),
				} as MessageEvent<string>),
			);
		}
	}
	vi.stubGlobal("WebSocket", MetaSocket);
	vi.stubGlobal("window", {
		setTimeout,
		clearTimeout,
		location: { origin: "http://127.0.0.1:3000" },
	});
	const { iframe, postMessage } = frame();
	const bridge = new EditorHostBridge(
		"video",
		"session",
		"user",
		vi.fn(),
		vi.fn(),
	);
	await bridge.connect(iframe);
	const port = postMessage.mock.calls[0]?.[2]?.[0] as MessagePort;
	port.start();
	try {
		for (const [id, name] of [
			[41, "getEditorMeta"],
			[42, "getRecordingMetaByPath"],
		] as const) {
			const reply = new Promise<unknown>((resolve) => {
				port.onmessage = (event) => resolve(event.data);
			});
			port.postMessage({ kind: "invoke", id, name, args: [] });
			expect(await reply).toEqual({
				kind: "result",
				id,
				value: {
					pretty_name: "Shared recording",
					sharing: {
						id: "video",
						link: "http://127.0.0.1:3000/s/video",
					},
				},
			});
		}
	} finally {
		port.close();
		bridge.dispose();
	}
});

const exportSettings = {
	format: "Mp4",
	fps: 30,
	resolution_base: { x: 640, y: 360 },
	compression: "Social",
	custom_bpp: null,
};

function exportState(
	status: "running" | "ready",
	downloadStartedAt: number | null = null,
	duration = 3,
) {
	return {
		id: "job",
		status,
		format: "Mp4",
		size: 160_000,
		mediaMetadata: { duration, width: 640, height: 358, fps: 30 },
		progress: {
			rendered_count: status === "ready" ? duration * 30 : 30,
			total_frames: duration * 30,
		},
		error: null,
		downloadStartedAt,
	};
}

test("a rendered MP4 is uploaded to the existing share link through bounded chunks", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const { bridge, port } = await connectedExportHost(async (url, init) => {
		requests.push({ url, init });
		if (url.endsWith("/exports"))
			return Response.json({ id: "job", status: "running" });
		if (init?.method === "DELETE") return Response.json({ canceled: true });
		if (url.includes("/exports/job?"))
			return Response.json(exportState("ready"));
		throw new Error(`Unexpected editor request: ${url}`);
	});
	const transfer = vi.mocked(uploadWebEditorExport);
	transfer.mockClear();
	transfer.mockImplementationOnce(async (...args) => {
		args[6]?.({ stage: "uploading", fraction: 0.5 });
	});
	const invoke = async (id: number, name: string, args: unknown[]) => {
		const messages: unknown[] = [];
		const reply = new Promise<unknown>((resolve) => {
			port.onmessage = (event) => {
				messages.push(event.data);
				if (
					typeof event.data === "object" &&
					event.data !== null &&
					"id" in event.data &&
					event.data.id === id &&
					"kind" in event.data &&
					event.data.kind !== "channel"
				) {
					resolve(event.data);
				}
			};
		});
		port.postMessage({ kind: "invoke", id, name, args });
		return { reply: await reply, messages };
	};
	try {
		const rendered = await invoke(11, "exportVideo", [
			"cap-web-editor://session/session",
			"__CHANNEL__:8",
			exportSettings,
		]);
		expect(rendered.reply).toEqual({
			kind: "result",
			id: 11,
			value: "cap-web-editor://export/job",
		});
		expect(rendered.messages).toContainEqual({
			kind: "channel",
			id: 8,
			value: {
				type: "FramesRendered",
				renderedCount: 90,
				totalFrames: 90,
			},
		});
		const shared = await invoke(12, "uploadExportedVideo", [
			"cap-web-editor://session/session",
			"Reupload",
			"__CHANNEL__:9",
			null,
		]);
		expect(shared.reply).toEqual({
			kind: "result",
			id: 12,
			value: { Success: "http://127.0.0.1:3000/s/video" },
		});
		expect(shared.messages).toContainEqual({
			kind: "channel",
			id: 9,
			value: { progress: 0.5 },
		});
		expect(transfer).toHaveBeenCalledOnce();
		expect(transfer.mock.calls[0]?.slice(0, 5)).toEqual([
			"video",
			"session",
			"job",
			160_000,
			{ duration: 3, width: 640, height: 358, fps: 30 },
		]);
		expect(requests.some((request) => request.init?.method === "DELETE")).toBe(
			true,
		);
	} finally {
		port.close();
		bridge.dispose();
	}
});

test("long share checks the current plan before upload after a downgrade", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const { bridge, port } = await connectedExportHost(async (url, init) => {
		requests.push({ url, init });
		if (url.endsWith("/exports"))
			return Response.json({ id: "job", status: "running" });
		if (url.includes("/exports/job?"))
			return Response.json(exportState("ready", null, 420));
		if (url.endsWith("/plan?videoId=video"))
			return Response.json({ pro: false });
		if (init?.method === "DELETE") return Response.json({ canceled: true });
		throw new Error(`Unexpected editor request: ${url}`);
	});
	const transfer = vi.mocked(uploadWebEditorExport);
	transfer.mockClear();
	const invoke = async (id: number, name: string, args: unknown[]) => {
		const reply = new Promise<unknown>((resolve) => {
			port.onmessage = (event: MessageEvent<unknown>) => {
				if (
					typeof event.data === "object" &&
					event.data !== null &&
					"id" in event.data &&
					event.data.id === id &&
					"kind" in event.data &&
					event.data.kind !== "channel"
				) {
					resolve(event.data);
				}
			};
		});
		port.postMessage({ kind: "invoke", id, name, args });
		return reply;
	};
	try {
		expect(
			await invoke(20, "exportVideo", [
				"cap-web-editor://session/session",
				"__CHANNEL__:8",
				exportSettings,
			]),
		).toEqual({ kind: "result", id: 20, value: "cap-web-editor://export/job" });
		expect(
			await invoke(21, "uploadExportedVideo", [
				"cap-web-editor://session/session",
				"Reupload",
				"__CHANNEL__:9",
				null,
			]),
		).toEqual({
			kind: "error",
			id: 21,
			error: "Cap Pro is required to share recordings longer than 5 minutes",
		});
		expect(
			requests.some((request) => request.url.endsWith("/plan?videoId=video")),
		).toBe(true);
		expect(requests.some((request) => request.init?.method === "DELETE")).toBe(
			true,
		);
		expect(transfer).not.toHaveBeenCalled();
	} finally {
		port.close();
		bridge.dispose();
	}
});

test("share controls use a fresh web plan and open the existing upgrade flow", async () => {
	let pro = false;
	const requests: string[] = [];
	const onUpgrade = vi.fn();
	const { bridge, port } = await connectedExportHost(
		async (url) => {
			requests.push(url);
			if (url.endsWith("/plan?videoId=video")) return Response.json({ pro });
			throw new Error(`Unexpected editor request: ${url}`);
		},
		false,
		onUpgrade,
	);
	const invoke = async (id: number, name: string, args: unknown[]) => {
		const reply = new Promise<unknown>((resolve) => {
			port.onmessage = (event: MessageEvent<unknown>) => resolve(event.data);
		});
		port.postMessage({ kind: "invoke", id, name, args });
		return reply;
	};
	try {
		expect(await invoke(1, "checkUpgradedAndUpdate", [])).toEqual({
			kind: "result",
			id: 1,
			value: false,
		});
		expect(await invoke(2, "showWindow", ["Upgrade"])).toEqual({
			kind: "result",
			id: 2,
			value: null,
		});
		expect(onUpgrade).toHaveBeenCalledOnce();
		pro = true;
		expect(await invoke(3, "checkUpgradedAndUpdate", [])).toEqual({
			kind: "result",
			id: 3,
			value: true,
		});
		expect(requests).toEqual([
			"/api/editor/sessions/session/plan?videoId=video",
			"/api/editor/sessions/session/plan?videoId=video",
		]);
	} finally {
		port.close();
		bridge.dispose();
	}
});

test("caption access follows a changed Cap Pro plan without reconnecting the editor", async () => {
	let pro = false;
	let captionRequests = 0;
	const captions = {
		settings: null,
		segments: [
			{
				id: "segment-0",
				text: "Hello",
				start: 0.1,
				end: 0.4,
				words: [{ text: "Hello", start: 0.1, end: 0.4 }],
			},
		],
	};
	const { bridge, port } = await connectedExportHost(async (url, init) => {
		if (url.endsWith("/plan?videoId=video")) return Response.json({ pro });
		if (url.endsWith("/captions") && init?.method === "POST") {
			captionRequests++;
			return Response.json({ status: "ready", captions, message: null });
		}
		throw new Error(`Unexpected editor request: ${url}`);
	});
	const invoke = async (id: number, name: string, args: unknown[] = []) => {
		const reply = new Promise<unknown>((resolve) => {
			port.onmessage = (event: MessageEvent<unknown>) => resolve(event.data);
		});
		port.postMessage({ kind: "invoke", id, name, args });
		return reply;
	};
	const transcriptionArgs = [
		"cap-web-editor://session/session",
		"cap-web-editor://app-local-data/transcription_models/best.bin",
		"auto",
		"Parakeet",
	];
	try {
		expect(await invoke(1, "transcribeAudio", transcriptionArgs)).toEqual({
			kind: "error",
			id: 1,
			error: "Cap Pro is required for web editor captions",
		});
		pro = true;
		expect(await invoke(2, "checkUpgradedAndUpdate")).toEqual({
			kind: "result",
			id: 2,
			value: true,
		});
		expect(await invoke(3, "transcribeAudio", transcriptionArgs)).toEqual({
			kind: "result",
			id: 3,
			value: captions,
		});
		pro = false;
		expect(await invoke(4, "checkUpgradedAndUpdate")).toEqual({
			kind: "result",
			id: 4,
			value: false,
		});
		expect(await invoke(5, "transcribeAudio", transcriptionArgs)).toEqual({
			kind: "error",
			id: 5,
			error: "Cap Pro is required for web editor captions",
		});
		expect(captionRequests).toBe(1);
	} finally {
		port.close();
		bridge.dispose();
	}
});

test("Solid export progress is delivered before a verified direct browser download", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	let polled = 0;
	let linkClicked = false;
	const anchor = {
		href: "",
		rel: "",
		download: "",
		click: vi.fn(() => {
			linkClicked = true;
		}),
		remove: vi.fn(),
	};
	const append = vi.fn();
	vi.stubGlobal("document", {
		createElement: vi.fn(() => anchor),
		body: { append },
	});
	const { bridge, port } = await connectedExportHost(async (url, init) => {
		requests.push({ url, init });
		if (url.endsWith("/exports") && init?.method === "POST") {
			return Response.json({ id: "job", status: "running" }, { status: 202 });
		}
		if (url.endsWith("/download-ticket")) {
			return Response.json({
				url: `http://127.0.0.1:1234/editor/sessions/session/exports/job/download?ticket=${ticket}`,
			});
		}
		if (url.includes("/exports/job?videoId=")) {
			polled++;
			return Response.json(
				linkClicked
					? exportState("ready", Date.now())
					: exportState(polled === 1 ? "running" : "ready"),
			);
		}
		throw new Error(`Unexpected request ${url}`);
	});
	const messages: unknown[] = [];
	const completed = new Promise<unknown>((resolve) => {
		port.onmessage = (event: MessageEvent<unknown>) => {
			messages.push(event.data);
			if (
				typeof event.data === "object" &&
				event.data !== null &&
				"kind" in event.data &&
				event.data.kind === "result"
			) {
				resolve(event.data);
			}
		};
	});
	port.postMessage({
		kind: "invoke",
		id: 7,
		name: "exportVideoToFile",
		args: [
			"cap-web-editor://session/session",
			"__CHANNEL__:42",
			exportSettings,
			"Paired test.mp4",
			"mp4",
		],
	});
	expect(await completed).toEqual({
		kind: "result",
		id: 7,
		value: "Paired test.mp4",
	});
	expect(messages).toContainEqual({
		kind: "channel",
		id: 42,
		value: { type: "FramesRendered", renderedCount: 90, totalFrames: 90 },
	});
	expect(messages.at(-1)).toEqual({
		kind: "result",
		id: 7,
		value: "Paired test.mp4",
	});
	expect(anchor.click).toHaveBeenCalledOnce();
	expect(anchor.href).toContain(
		"/editor/sessions/session/exports/job/download",
	);
	expect(anchor.download).toBe("Paired test.mp4");
	expect(append).toHaveBeenCalledWith(anchor);
	expect(
		requests.find((request) => request.url.endsWith("/exports"))?.init?.body,
	).toBe(JSON.stringify({ videoId: "video", settings: exportSettings }));
	expect(requests.some((request) => request.init?.method === "DELETE")).toBe(
		false,
	);
	port.close();
	bridge.dispose();
});

test("canceling while export creation is pending still deletes the native job", async () => {
	let resolveStart: (response: Response) => void = () => undefined;
	const pendingStart = new Promise<Response>((resolve) => {
		resolveStart = resolve;
	});
	const deleted = vi.fn(async () => Response.json({ canceled: true }));
	const { bridge, port } = await connectedExportHost(async (url, init) => {
		if (url.endsWith("/exports") && init?.method === "POST")
			return pendingStart;
		if (url.includes("/exports/job?videoId=") && init?.method === "DELETE")
			return deleted();
		throw new Error(`Unexpected request ${url}`);
	});
	const messages: unknown[] = [];
	port.onmessage = (event: MessageEvent<unknown>) => {
		messages.push(event.data);
	};
	port.postMessage({
		kind: "invoke",
		id: 7,
		name: "exportVideoToFile",
		args: [
			"cap-web-editor://session/session",
			"__CHANNEL__:42",
			exportSettings,
			"Paired test.mp4",
			"mp4",
		],
	});
	port.postMessage({
		kind: "invoke",
		id: 8,
		name: "cancelCurrentWindowExports",
		args: [],
	});
	await vi.waitFor(() =>
		expect(messages).toContainEqual({ kind: "result", id: 8, value: null }),
	);
	resolveStart(
		Response.json({ id: "job", status: "running" }, { status: 202 }),
	);
	await vi.waitFor(() =>
		expect(messages).toContainEqual({
			kind: "error",
			id: 7,
			error: "Export cancelled",
		}),
	);
	await vi.waitFor(() => expect(deleted).toHaveBeenCalledOnce());
	port.close();
	bridge.dispose();
});

test("canceling a file export acknowledges the dialog and retries after native cleanup", async () => {
	let resolveStart: (response: Response) => void = () => undefined;
	const pendingStart = new Promise<Response>((resolve) => {
		resolveStart = resolve;
	});
	let resolveDelete: (response: Response) => void = () => undefined;
	const pendingDelete = new Promise<Response>((resolve) => {
		resolveDelete = resolve;
	});
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	let starts = 0;
	let linkClicked = false;
	const anchor = {
		href: "",
		rel: "",
		download: "",
		click: vi.fn(() => {
			linkClicked = true;
		}),
		remove: vi.fn(),
	};
	vi.stubGlobal("document", {
		createElement: vi.fn(() => anchor),
		body: { append: vi.fn() },
	});
	const { bridge, port } = await connectedExportHost(async (url, init) => {
		requests.push({ url, init });
		if (url.endsWith("/exports") && init?.method === "POST") {
			starts++;
			return starts === 1
				? pendingStart
				: Response.json({ id: "retry", status: "running" }, { status: 202 });
		}
		if (url.includes("/exports/job?videoId=") && init?.method === "DELETE")
			return pendingDelete;
		if (url.includes("/exports/retry?videoId="))
			return Response.json({
				...exportState("ready", linkClicked ? Date.now() : null),
				id: "retry",
			});
		if (url.endsWith("/exports/retry/download-ticket"))
			return Response.json({
				url: `http://127.0.0.1:1234/editor/sessions/session/exports/retry/download?ticket=${ticket}`,
			});
		throw new Error(`Unexpected request ${url}`);
	});
	const messages: unknown[] = [];
	port.onmessage = (event: MessageEvent<unknown>) => {
		messages.push(event.data);
	};
	const fileArgs = [
		"cap-web-editor://session/session",
		"__CHANNEL__:42",
		exportSettings,
		"Paired test.mp4",
		"mp4",
	];
	try {
		port.postMessage({
			kind: "invoke",
			id: 7,
			name: "exportVideoToFile",
			args: fileArgs,
		});
		await vi.waitFor(() => expect(starts).toBe(1));
		port.postMessage({
			kind: "invoke",
			id: 6,
			name: "exportVideoToFile",
			args: fileArgs,
		});
		await vi.waitFor(() =>
			expect(messages).toContainEqual({
				kind: "error",
				id: 6,
				error: "Finish or cancel the current editor export first",
			}),
		);
		port.postMessage({
			kind: "invoke",
			id: 8,
			name: "cancelCurrentWindowExports",
			args: [],
		});
		await vi.waitFor(() => {
			expect(messages).toContainEqual({
				kind: "error",
				id: 7,
				error: "Export cancelled",
			});
			expect(messages).toContainEqual({ kind: "result", id: 8, value: null });
		});
		expect(
			requests.find(
				(request) =>
					request.url.endsWith("/exports") && request.init?.method === "POST",
			)?.init?.signal?.aborted,
		).toBe(false);
		port.postMessage({
			kind: "invoke",
			id: 9,
			name: "exportVideoToFile",
			args: fileArgs,
		});
		resolveStart(
			Response.json({ id: "job", status: "running" }, { status: 202 }),
		);
		await vi.waitFor(() =>
			expect(
				requests.some(
					(request) =>
						request.url.includes("/exports/job?videoId=") &&
						request.init?.method === "DELETE",
				),
			).toBe(true),
		);
		expect(starts).toBe(1);
		expect(messages).not.toContainEqual({
			kind: "error",
			id: 9,
			error: "Finish or cancel the current editor export first",
		});
		resolveDelete(Response.json({ canceled: true }));
		await vi.waitFor(() =>
			expect(messages).toContainEqual({
				kind: "result",
				id: 9,
				value: "Paired test.mp4",
			}),
		);
		expect(starts).toBe(2);
		expect(anchor.click).toHaveBeenCalledOnce();
		expect(
			messages.filter(
				(message) =>
					typeof message === "object" &&
					message !== null &&
					"id" in message &&
					message.id === 7,
			),
		).toHaveLength(1);
	} finally {
		port.close();
		bridge.dispose();
	}
});

test("canceling a prepared share waits for job deletion before starting another export", async () => {
	let resolveDelete: (response: Response) => void = () => undefined;
	const pendingDelete = new Promise<Response>((resolve) => {
		resolveDelete = resolve;
	});
	let starts = 0;
	const { bridge, port } = await connectedExportHost(async (url, init) => {
		if (url.endsWith("/exports") && init?.method === "POST") {
			starts++;
			return Response.json(
				{ id: starts === 1 ? "job" : "retry", status: "running" },
				{ status: 202 },
			);
		}
		if (url.includes("/exports/job?videoId=") && init?.method === "DELETE")
			return pendingDelete;
		if (url.includes("/exports/job?videoId="))
			return Response.json(exportState("ready"));
		if (url.includes("/exports/retry?videoId="))
			return Response.json({ ...exportState("ready"), id: "retry" });
		throw new Error(`Unexpected request ${url}`);
	});
	const messages: unknown[] = [];
	port.onmessage = (event: MessageEvent<unknown>) => {
		messages.push(event.data);
	};
	const args = [
		"cap-web-editor://session/session",
		"__CHANNEL__:42",
		exportSettings,
	];
	try {
		port.postMessage({ kind: "invoke", id: 7, name: "exportVideo", args });
		await vi.waitFor(() =>
			expect(messages).toContainEqual({
				kind: "result",
				id: 7,
				value: "cap-web-editor://export/job",
			}),
		);
		port.postMessage({
			kind: "invoke",
			id: 8,
			name: "cancelCurrentWindowExports",
			args: [],
		});
		await vi.waitFor(() =>
			expect(messages).toContainEqual({ kind: "result", id: 8, value: null }),
		);
		port.postMessage({ kind: "invoke", id: 9, name: "exportVideo", args });
		await vi.waitFor(() => expect(starts).toBe(1));
		expect(messages).not.toContainEqual({
			kind: "error",
			id: 9,
			error: "Finish or cancel the current editor export first",
		});
		resolveDelete(Response.json({ canceled: true }));
		await vi.waitFor(() =>
			expect(messages).toContainEqual({
				kind: "result",
				id: 9,
				value: "cap-web-editor://export/retry",
			}),
		);
		expect(starts).toBe(2);
	} finally {
		port.close();
		bridge.dispose();
	}
});

test("a stalled export start releases a canceled retry and deletes a late native job", async () => {
	let resolveStart: (response: Response) => void = () => undefined;
	const pendingStart = new Promise<Response>((resolve) => {
		resolveStart = resolve;
	});
	let resolveFirstStarted: () => void = () => undefined;
	const firstStarted = new Promise<void>((resolve) => {
		resolveFirstStarted = resolve;
	});
	let resolveDeleted: () => void = () => undefined;
	const nativeDeleted = new Promise<void>((resolve) => {
		resolveDeleted = resolve;
	});
	let starts = 0;
	const startSignals: AbortSignal[] = [];
	const deleted = vi.fn(async () => Response.json({ canceled: true }));
	const { bridge, port } = await connectedExportHost(async (url, init) => {
		if (url.endsWith("/exports") && init?.method === "POST") {
			starts++;
			if (starts === 1) {
				if (init.signal) startSignals.push(init.signal);
				resolveFirstStarted();
				return pendingStart;
			}
			return Response.json({ id: "retry", status: "running" }, { status: 202 });
		}
		if (url.includes("/exports/orphan?videoId=") && init?.method === "DELETE") {
			resolveDeleted();
			return deleted();
		}
		if (url.includes("/exports/retry?videoId="))
			return Response.json({ ...exportState("ready"), id: "retry" });
		throw new Error(`Unexpected request ${url}`);
	});
	const messages: unknown[] = [];
	let resolveCancel: () => void = () => undefined;
	const canceled = new Promise<void>((resolve) => {
		resolveCancel = resolve;
	});
	let resolveRetry: (reply: unknown) => void = () => undefined;
	const retried = new Promise<unknown>((resolve) => {
		resolveRetry = resolve;
	});
	port.onmessage = (event: MessageEvent<unknown>) => {
		messages.push(event.data);
		const reply = event.data;
		if (typeof reply !== "object" || reply === null || !("id" in reply)) return;
		if (reply.id === 8 && "kind" in reply && reply.kind === "result")
			resolveCancel();
		if (reply.id === 9 && "kind" in reply && reply.kind !== "channel")
			resolveRetry(reply);
	};
	vi.stubGlobal("window", {
		...window,
		setTimeout: (handler: () => void, delay: number) =>
			Number(globalThis.setTimeout(handler, delay)),
		clearTimeout: (id: number) => globalThis.clearTimeout(id),
	});
	vi.useFakeTimers();
	const args = [
		"cap-web-editor://session/session",
		"__CHANNEL__:42",
		exportSettings,
	];
	try {
		port.postMessage({ kind: "invoke", id: 7, name: "exportVideo", args });
		await firstStarted;
		port.postMessage({
			kind: "invoke",
			id: 8,
			name: "cancelCurrentWindowExports",
			args: [],
		});
		await canceled;
		expect(messages).toContainEqual({
			kind: "error",
			id: 7,
			error: "Export cancelled",
		});
		port.postMessage({ kind: "invoke", id: 9, name: "exportVideo", args });
		await vi.advanceTimersByTimeAsync(20_001);
		expect(await retried).toEqual({
			kind: "result",
			id: 9,
			value: "cap-web-editor://export/retry",
		});
		expect(starts).toBe(2);
		expect(startSignals[0]?.aborted).toBe(true);
		resolveStart(
			Response.json({ id: "orphan", status: "running" }, { status: 202 }),
		);
		await nativeDeleted;
		expect(deleted).toHaveBeenCalledOnce();
		expect(
			messages.filter(
				(message) =>
					typeof message === "object" &&
					message !== null &&
					"id" in message &&
					message.id === 7,
			),
		).toHaveLength(1);
	} finally {
		vi.useRealTimers();
		port.close();
		bridge.dispose();
	}
});

test("a stalled native export deletion cannot hold a prepared-share retry forever", async () => {
	let resolveDeleteRequested: () => void = () => undefined;
	const deleteRequested = new Promise<void>((resolve) => {
		resolveDeleteRequested = resolve;
	});
	const pendingDelete = new Promise<Response>(() => undefined);
	let starts = 0;
	const { bridge, port } = await connectedExportHost(async (url, init) => {
		if (url.endsWith("/exports") && init?.method === "POST") {
			starts++;
			return Response.json(
				{ id: starts === 1 ? "job" : "retry", status: "running" },
				{ status: 202 },
			);
		}
		if (url.includes("/exports/job?videoId=") && init?.method === "DELETE") {
			resolveDeleteRequested();
			return pendingDelete;
		}
		if (url.includes("/exports/job?videoId="))
			return Response.json(exportState("ready"));
		if (url.includes("/exports/retry?videoId="))
			return Response.json({ ...exportState("ready"), id: "retry" });
		throw new Error(`Unexpected request ${url}`);
	});
	const messages: unknown[] = [];
	const awaited = new Map<number, (reply: unknown) => void>();
	port.onmessage = (event: MessageEvent<unknown>) => {
		messages.push(event.data);
		const reply = event.data;
		if (typeof reply === "object" && reply !== null && "id" in reply)
			awaited.get(Number(reply.id))?.(reply);
	};
	const invoke = (id: number, name: string) => {
		const reply = new Promise<unknown>((resolve) => awaited.set(id, resolve));
		port.postMessage({
			kind: "invoke",
			id,
			name,
			args:
				name === "cancelCurrentWindowExports"
					? []
					: [
							"cap-web-editor://session/session",
							"__CHANNEL__:42",
							exportSettings,
						],
		});
		return reply;
	};
	vi.stubGlobal("window", {
		...window,
		setTimeout: (handler: () => void, delay: number) =>
			Number(globalThis.setTimeout(handler, delay)),
		clearTimeout: (id: number) => globalThis.clearTimeout(id),
	});
	vi.useFakeTimers();
	try {
		expect(await invoke(7, "exportVideo")).toEqual({
			kind: "result",
			id: 7,
			value: "cap-web-editor://export/job",
		});
		expect(await invoke(8, "cancelCurrentWindowExports")).toEqual({
			kind: "result",
			id: 8,
			value: null,
		});
		const retry = invoke(9, "exportVideo");
		await deleteRequested;
		expect(starts).toBe(1);
		await vi.advanceTimersByTimeAsync(10_001);
		expect(await retry).toEqual({
			kind: "result",
			id: 9,
			value: "cap-web-editor://export/retry",
		});
		expect(starts).toBe(2);
		expect(messages).not.toContainEqual({
			kind: "error",
			id: 9,
			error: "Finish or cancel the current editor export first",
		});
	} finally {
		vi.useRealTimers();
		port.close();
		bridge.dispose();
	}
});

test.each(["put", "driveResumable"] as const)(
	"imported audio uses a %s storage target before adding a native timeline asset",
	async (targetType) => {
		const path = "assets/audio/import-6516dffa-756a-4ed2-b595-5f2845d15d9a.mp3";
		const key = `user/video/editor-assets/${path.slice("assets/audio/".length)}`;
		const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const file = new File([bytes], "tone.mp3", { type: "audio/mpeg" });
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const { bridge, port } = await connectedExportHost(async (url, init) => {
			requests.push({ url, init });
			if (
				url === "/api/editor/sessions/session/assets" &&
				init?.method === "POST"
			) {
				return Response.json({
					key,
					path,
					upload: {
						type: targetType,
						url: "https://storage.cap.so/upload/audio",
						headers: { "Content-Type": "audio/mpeg" },
					},
				});
			}
			if (url === "https://storage.cap.so/upload/audio") {
				return new Response(null, { status: 200 });
			}
			if (
				url === "/api/editor/sessions/session/assets" &&
				init?.method === "PUT"
			) {
				return Response.json({ path, name: "tone", duration: 3.2 });
			}
			throw new Error(`Unexpected request ${url}`);
		});
		const completed = new Promise<unknown>((resolve) => {
			port.onmessage = (event: MessageEvent<unknown>) => resolve(event.data);
		});
		port.postMessage({
			kind: "invoke",
			id: 17,
			name: "importAudioTrackFile",
			args: [file],
		});
		expect(await completed).toEqual({
			kind: "result",
			id: 17,
			value: { path, name: "tone", duration: 3.2 },
		});
		expect(requests.map(({ url, init }) => [url, init?.method])).toEqual([
			["/api/editor/sessions/session/assets", "POST"],
			["https://storage.cap.so/upload/audio", "PUT"],
			["/api/editor/sessions/session/assets", "PUT"],
		]);
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			kind: "audio",
			videoId: "video",
			fileName: "tone.mp3",
			size: bytes.length,
			contentType: "audio/mpeg",
		});
		const upload = requests[1]?.init;
		expect(upload?.body).toBeInstanceOf(File);
		expect(new Uint8Array(await (upload?.body as File).arrayBuffer())).toEqual(
			bytes,
		);
		expect(upload?.credentials).toBe("omit");
		expect(new Headers(upload?.headers).get("Content-Type")).toBe("audio/mpeg");
		expect(new Headers(upload?.headers).get("Content-Range")).toBe(
			targetType === "driveResumable" ? "bytes 0-7/8" : null,
		);
		expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
			kind: "audio",
			videoId: "video",
			fileName: "tone.mp3",
			size: bytes.length,
			contentType: "audio/mpeg",
			key,
			path,
		});
		port.close();
		bridge.dispose();
	},
);

test("failed audio upload never commits the timeline asset", async () => {
	const path = "assets/audio/import-6516dffa-756a-4ed2-b595-5f2845d15d9a.mp3";
	const key = `user/video/editor-assets/${path.slice("assets/audio/".length)}`;
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const { bridge, port } = await connectedExportHost(async (url, init) => {
		requests.push({ url, init });
		if (init?.method === "POST") {
			return Response.json({
				key,
				path,
				upload: {
					type: "put",
					url: "https://storage.cap.so/upload/audio",
					headers: { "Content-Type": "audio/mpeg" },
				},
			});
		}
		return new Response(null, { status: 503 });
	});
	const reply = new Promise<unknown>((resolve) => {
		port.onmessage = (event: MessageEvent<unknown>) => resolve(event.data);
	});
	port.postMessage({
		kind: "invoke",
		id: 18,
		name: "importAudioTrackFile",
		args: [new File([new Uint8Array([1])], "tone.mp3")],
	});
	await expect(reply).resolves.toEqual({
		kind: "error",
		id: 18,
		error: "Audio upload failed",
	});
	expect(requests).toHaveLength(2);
	expect(
		requests.every(
			({ init }) =>
				init?.method !== "PUT" || !String(init.body).includes("videoId"),
		),
	).toBe(true);
	port.close();
	bridge.dispose();
});

test.each([
	{
		label: "JPEG",
		fileExtension: "jpeg",
		assetExtension: "jpg",
		contentType: "image/jpeg",
		bytes: new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4]),
	},
	{
		label: "TIFF",
		fileExtension: "tif",
		assetExtension: "tiff",
		contentType: "image/tiff",
		bytes: new Uint8Array([73, 73, 42, 0, 1, 2, 3, 4]),
	},
])(
	"imported $label images preserve their bytes and return desktop image dimensions",
	async ({ fileExtension, assetExtension, contentType, bytes }) => {
		const path = `content/images/6516dffa-756a-4ed2-b595-5f2845d15d9a.${assetExtension}`;
		const key = `user/video/editor-assets/images/${path.slice("content/images/".length)}`;
		const fileName = `logo.${fileExtension}`;
		const file = new File([bytes], fileName, { type: contentType });
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const { bridge, port } = await connectedExportHost(async (url, init) => {
			requests.push({ url, init });
			if (init?.method === "POST") {
				return Response.json({
					key,
					path,
					upload: {
						type: "put",
						url: "https://storage.cap.so/upload/image",
						headers: { "Content-Type": contentType },
					},
				});
			}
			if (url === "https://storage.cap.so/upload/image") {
				return new Response(null, { status: 200 });
			}
			if (init?.method === "PUT") {
				return Response.json({ path, name: "logo", width: 120, height: 80 });
			}
			throw new Error(`Unexpected request ${url}`);
		});
		const reply = new Promise<unknown>((resolve) => {
			port.onmessage = (event: MessageEvent<unknown>) => resolve(event.data);
		});
		port.postMessage({
			kind: "invoke",
			id: 19,
			name: "importEditorImage",
			args: [file],
		});
		expect(await reply).toEqual({
			kind: "result",
			id: 19,
			value: { path, name: "logo", width: 120, height: 80 },
		});
		expect(requests.map(({ url, init }) => [url, init?.method])).toEqual([
			["/api/editor/sessions/session/assets", "POST"],
			["https://storage.cap.so/upload/image", "PUT"],
			["/api/editor/sessions/session/assets", "PUT"],
		]);
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			kind: "image",
			videoId: "video",
			fileName,
			size: bytes.length,
			contentType,
		});
		expect(
			new Uint8Array(await (requests[1]?.init?.body as File).arrayBuffer()),
		).toEqual(bytes);
		expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
			kind: "image",
			videoId: "video",
			fileName,
			size: bytes.length,
			contentType,
			key,
			path,
		});
		port.close();
		bridge.dispose();
	},
);

test("Solid caption commands share one authenticated AssemblyAI request and bypass native models", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	let resolveCaption: (response: Response) => void = () => undefined;
	const pendingCaption = new Promise<Response>((resolve) => {
		resolveCaption = resolve;
	});
	const { bridge, port } = await connectedExportHost(async (url, init) => {
		requests.push({ url, init });
		if (url === "/api/editor/sessions/session/plan?videoId=video") {
			return Response.json({ pro: true });
		}
		if (
			url === "/api/editor/sessions/session/captions" &&
			init?.method === "POST"
		) {
			return pendingCaption;
		}
		throw new Error(`Unexpected request ${url}`);
	}, true);
	const replies: unknown[] = [];
	port.onmessage = (event: MessageEvent<unknown>) => {
		replies.push(event.data);
	};
	for (const id of [41, 42]) {
		port.postMessage({
			kind: "invoke",
			id,
			name: "transcribeAudio",
			args: [
				"cap-web-editor://session/session",
				"cap-web-editor://app-local-data/transcription_models/best.bin",
				"auto",
				"Parakeet",
			],
		});
	}
	await vi.waitFor(() =>
		expect(
			requests.filter((request) => request.init?.method === "POST"),
		).toHaveLength(1),
	);
	const captions = {
		settings: null,
		segments: [
			{
				id: "segment-0",
				text: "Hello",
				start: 0.1,
				end: 0.4,
				words: [{ text: "Hello", start: 0.1, end: 0.4 }],
			},
		],
	};
	resolveCaption(Response.json({ status: "ready", captions, message: null }));
	await vi.waitFor(() => expect(replies).toHaveLength(2));
	expect(replies).toContainEqual({ kind: "result", id: 41, value: captions });
	expect(replies).toContainEqual({ kind: "result", id: 42, value: captions });
	const captionRequest = requests.find(
		(request) => request.init?.method === "POST",
	);
	expect(captionRequest?.url).toBe("/api/editor/sessions/session/captions");
	expect(JSON.parse(String(captionRequest?.init?.body))).toEqual({
		videoId: "video",
		language: "auto",
	});
	port.close();
	bridge.dispose();
});
