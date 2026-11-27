import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EditorHostBridge } from "../../app/s/[videoId]/edit/studio/editor-host";
import { uploadWebEditorFile } from "../../lib/editor-export-upload-client";

vi.mock("@/lib/editor-export-upload-client", () => ({
	uploadWebEditorFile: vi.fn(async () => undefined),
}));

vi.mock("@/lib/share-video-updates", () => ({
	announceShareVideoUpdate: vi.fn(),
}));

type Reply = { kind: string; id?: number; value?: unknown; error?: string };
type FetchCall = { url: string; method: string; body: unknown };

const ORIGIN = "http://127.0.0.1:3000";

beforeEach(() => {
	vi.stubGlobal("window", {
		setTimeout,
		clearTimeout,
		location: { origin: ORIGIN },
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		alert: vi.fn(),
	});
	vi.stubGlobal("document", {
		hidden: false,
		addEventListener: vi.fn(),
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.mocked(uploadWebEditorFile).mockClear();
});

function stubFetch(
	respond: (call: FetchCall) => Response | Promise<Response>,
): FetchCall[] {
	const calls: FetchCall[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL, init?: RequestInit) => {
			const call = {
				url: String(input),
				method: init?.method ?? "GET",
				body:
					typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			};
			calls.push(call);
			return respond(call);
		}),
	);
	return calls;
}

async function connectedHost(
	options: Partial<ConstructorParameters<typeof EditorHostBridge>[0]> = {},
) {
	let editorPort: MessagePort | null = null;
	let connectMessage: unknown = null;
	const postMessage = vi.fn(
		(message: unknown, _origin: string, ports?: MessagePort[]) => {
			connectMessage = message;
			editorPort = ports?.[0] ?? null;
			editorPort?.postMessage({ kind: "mount", status: "ready" });
		},
	);
	const bridge = new EditorHostBridge({
		videoId: "video",
		userId: "user",
		captionsEnabled: true,
		onClose: vi.fn(),
		onFailure: vi.fn(),
		...options,
	});
	await bridge.connect({
		contentWindow: { postMessage },
	} as unknown as HTMLIFrameElement);
	const port = editorPort as MessagePort | null;
	if (!port) throw new Error("Editor port was not transferred");
	const waiting = new Map<number, (reply: Reply) => void>();
	const channels: Reply[] = [];
	port.onmessage = (event: MessageEvent<Reply>) => {
		const reply = event.data;
		if (reply.kind === "channel") {
			channels.push(reply);
			return;
		}
		if (reply.kind !== "result" && reply.kind !== "error") return;
		if (reply.id === undefined) return;
		waiting.get(reply.id)?.(reply);
		waiting.delete(reply.id);
	};
	let nextId = 1;
	const invoke = (name: string, args: unknown[] = []) => {
		const id = nextId++;
		const replied = new Promise<Reply>((resolve) => waiting.set(id, resolve));
		port.postMessage({ kind: "invoke", id, name, args });
		return replied;
	};
	return { bridge, invoke, connectMessage, channels, port };
}

test("connects the editor as a browser session with no server sockets", async () => {
	const calls = stubFetch(() => new Response(null, { status: 500 }));
	const { bridge, connectMessage } = await connectedHost();
	expect(connectMessage).toEqual({
		kind: "cap-editor-connect",
		version: 1,
		videoId: "video",
		userId: "user",
		captionsEnabled: true,
		assetBase: "/api/editor/videos/video/file?raw=1",
		browserSessionId: "browser-video",
	});
	expect(calls).toEqual([]);
	bridge.dispose();
});

test("autosaves the project and reports the stored revision", async () => {
	const calls = stubFetch(() =>
		Response.json({ saved: true, savedAt: "2026-11-23T00:00:01.000Z" }),
	);
	const onProjectSaved = vi.fn();
	const { bridge, invoke } = await connectedHost({
		onProjectSaved,
		getProjectSavedAt: () => "2026-11-23T00:00:00.000Z",
	});
	const reply = await invoke("setProjectConfig", [{ timeline: null }]);
	expect(reply).toMatchObject({ kind: "result", value: null });
	expect(calls).toEqual([
		{
			url: "/api/editor/videos/video/config",
			method: "PUT",
			body: {
				config: { timeline: null },
				expectedSavedAt: "2026-11-23T00:00:00.000Z",
			},
		},
	]);
	expect(onProjectSaved).toHaveBeenCalledWith("2026-11-23T00:00:01.000Z");
	bridge.dispose();
});

test("a conflicting autosave asks the owner to reload", async () => {
	stubFetch(() => new Response(null, { status: 409 }));
	const { bridge, invoke } = await connectedHost({
		getProjectSavedAt: () => null,
	});
	const reply = await invoke("setProjectConfig", [{}]);
	expect(reply.error).toBe(
		"Editor changed in another tab or caption data is unavailable. Reload to continue.",
	);
	bridge.dispose();
});

test("Save starts on the render farm when it can take the project", async () => {
	const calls = stubFetch(({ method }) =>
		method === "GET"
			? Response.json({ renderer: "farm", reason: null })
			: Response.json({ shareUrl: "https://cap.so/s/video" }),
	);
	const { bridge, invoke } = await connectedHost();
	const reply = await invoke("tauri:webEditorSave");
	expect(reply.value).toEqual({
		renderer: "farm",
		shareUrl: "https://cap.so/s/video",
	});
	expect(calls.map(({ url, method }) => `${method} ${url}`)).toEqual([
		"GET /api/editor/videos/video/save",
		"POST /api/editor/videos/video/save",
	]);
	bridge.dispose();
});

test("Save renders in the browser when the farm can't start it", async () => {
	stubFetch(({ method }) =>
		method === "GET"
			? Response.json({ renderer: "farm", reason: null })
			: new Response(null, { status: 503 }),
	);
	const { bridge, invoke } = await connectedHost();
	const reply = await invoke("tauri:webEditorSave");
	expect(reply.value).toEqual({
		renderer: "browser",
		reason: "The render farm could not start the save (503)",
	});
	bridge.dispose();
});

test("Save renders in the browser without asking the farm when it isn't there", async () => {
	const calls = stubFetch(() =>
		Response.json({
			renderer: "browser",
			reason: "The render farm is not configured",
		}),
	);
	const { bridge, invoke } = await connectedHost();
	const reply = await invoke("tauri:webEditorSave");
	expect(reply.value).toEqual({
		renderer: "browser",
		reason: "The render farm is not configured",
	});
	expect(calls).toHaveLength(1);
	bridge.dispose();
});

test("Save says plainly when the share link already shows the project", async () => {
	stubFetch(() => new Response(null, { status: 409 }));
	const { bridge, invoke } = await connectedHost();
	const reply = await invoke("tauri:webEditorSave");
	expect(reply.error).toBe("Your share link already shows this version");
	bridge.dispose();
});

test("publishes a browser-rendered Save and marks it published", async () => {
	const published = Promise.withResolvers<void>();
	const calls = stubFetch(({ method }) => {
		if (method === "POST") return Response.json({ saveId: "save-1" });
		published.resolve();
		return Response.json({ ok: true });
	});
	const { bridge, invoke } = await connectedHost();
	const metadata = { duration: 12, width: 1920, height: 1080, fps: 30 };
	const file = new Blob([new Uint8Array(16)], { type: "video/mp4" });
	const reply = await invoke("tauri:webEditorPublishRendered", [
		file,
		metadata,
		"__CHANNEL__:4",
	]);
	expect(reply.value).toEqual({ shareUrl: `${ORIGIN}/s/video` });
	expect(uploadWebEditorFile).toHaveBeenCalledWith(
		"video",
		"save-1",
		file,
		metadata,
		expect.any(AbortSignal),
		expect.any(Function),
	);
	await published.promise;
	expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual(
		[
			{
				url: "/api/editor/videos/video/browser-save",
				method: "POST",
				body: {},
			},
			{
				url: "/api/editor/videos/video/browser-save",
				method: "PUT",
				body: { saveId: "save-1", status: "published" },
			},
		],
	);
	bridge.dispose();
});

test("worker-only commands fail with a clear message", async () => {
	stubFetch(() => new Response(null, { status: 500 }));
	const { bridge, invoke } = await connectedHost();
	expect((await invoke("tauri:webEditorSaveOnWorker")).error).toBe(
		"Save couldn't finish on Cap's servers. Try again.",
	);
	expect((await invoke("tauri:download_editor_bundle")).error).toBe(
		"Project downloads aren't available on the web yet.",
	);
	expect(
		(
			await invoke("exportVideoToFile", [
				"cap-web-editor://session/browser-video",
				"__CHANNEL__:1",
				{ format: "Gif" },
				"clip.gif",
				"gif",
			])
		).error,
	).toBe("GIF export isn't available on the web yet.");
	expect(
		(
			await invoke("exportVideoToFile", [
				"cap-web-editor://session/browser-video",
				"__CHANNEL__:1",
				{ format: "Mp4" },
				"clip.mp4",
				"mp4",
			])
		).error,
	).toBe("This browser can't render the video. Try Chrome or Edge.");
	expect((await invoke("someUnknownCommand")).error).toBe(
		"Browser editor command is unavailable: someUnknownCommand",
	);
	bridge.dispose();
});

test("Cap recording bundles are refused before any upload", async () => {
	const calls = stubFetch(() => new Response(null, { status: 500 }));
	const { bridge, invoke } = await connectedHost();
	const reply = await invoke("addExistingRecordingToEditor", [
		new File([new Uint8Array(4)], "Old.capbundle"),
	]);
	expect(reply.error).toBe(
		"Cap recording imports aren't available on the web yet. Import an MP4 instead.",
	);
	expect(calls).toEqual([]);
	bridge.dispose();
});

test("captions need Cap Pro", async () => {
	stubFetch(() => Response.json({ pro: false }));
	const { bridge, invoke } = await connectedHost();
	const reply = await invoke("transcribeAudio", [
		"cap-web-editor://session/browser-video",
		"",
		"auto",
		"",
	]);
	expect(reply.error).toBe("Cap Pro is required for web editor captions");
	bridge.dispose();
});
