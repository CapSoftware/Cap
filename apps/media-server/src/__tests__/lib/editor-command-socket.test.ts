import { expect, test } from "bun:test";
import {
	dispatchEditorSocketCommand,
	type EditorCommandState,
	type EditorSocketRequest,
	parseEditorSocketRequest,
} from "../../lib/editor-command-socket";

function state(): EditorCommandState {
	return {
		frameNumber: 0,
		fps: 60,
		resolutionBase: { x: 960, y: 540 },
	};
}

function command(name: string, args: unknown[] = []): EditorSocketRequest {
	return { kind: "invoke", id: 7, name, args };
}

test("the command socket rejects malformed envelopes before dispatch", () => {
	expect(
		parseEditorSocketRequest({
			kind: "invoke",
			id: 0,
			name: "seekTo",
			args: [1],
		}),
	).toBeNull();
	expect(
		parseEditorSocketRequest({
			kind: "invoke",
			id: 1,
			name: "seekTo",
			args: "1",
		}),
	).toBeNull();
	expect(
		parseEditorSocketRequest({
			kind: "emit",
			id: 1,
			name: "renderFrameEvent",
			args: [{}],
		}),
	).not.toBeNull();
});

test("the browser instance exposes an opaque project path and no renderer loopback socket", async () => {
	const native = async (path: string) => {
		if (path === "/instance") {
			return {
				instanceId: "native-id",
				path: "/private/user-media.cap",
				framesSocketUrl: "ws://127.0.0.1:5000/frames",
				audioSocketUrl: "ws://127.0.0.1:5000/audio",
				eventsSocketUrl: "ws://127.0.0.1:5000/events",
			};
		}
		return null;
	};
	const reply = await dispatchEditorSocketCommand(
		"session-id",
		command("createEditorInstance"),
		state(),
		native,
	);
	expect(reply.kind).toBe("result");
	if (reply.kind !== "result") return;
	expect(reply.value).toMatchObject({
		instanceId: "native-id",
		path: "cap-web-editor://session/session-id",
		framesSocketUrl: "",
		audioSocketUrl: "",
		eventsSocketUrl: "",
	});
	const invalidPath = await dispatchEditorSocketCommand(
		"session-id",
		command("getRecordingMetaByPath", ["/private/user-media.cap"]),
		state(),
		native,
	);
	expect(invalidPath).toMatchObject({
		kind: "error",
		error: "Invalid editor project path",
	});
});

test("shareable link checks use the authenticated web editor session", async () => {
	const native = async (path: string) =>
		path === "/instance" ? { recordingDuration: 420 } : null;
	const projectPath = "cap-web-editor://session/session-id";
	const metadata = await dispatchEditorSocketCommand(
		"session-id",
		command("getVideoMetadata", [projectPath]),
		state(),
		native,
	);
	expect(metadata).toEqual({
		kind: "result",
		id: 7,
		value: { duration: 420, size: (8_192_000 * 420) / (8 * 1024 * 1024) },
	});
	const invalid = await dispatchEditorSocketCommand(
		"session-id",
		command("getVideoMetadata", ["/private/user-media.cap"]),
		state(),
		native,
	);
	expect(invalid).toMatchObject({
		kind: "error",
		error: "Invalid editor project path",
	});
	const plan = await dispatchEditorSocketCommand(
		"session-id",
		command("checkUpgradedAndUpdate"),
		state(),
		native,
	);
	expect(plan).toEqual({ kind: "result", id: 7, value: false });
	expect(
		await dispatchEditorSocketCommand(
			"session-id",
			command("checkUpgradedAndUpdate"),
			{ ...state(), captionsEnabled: true },
			native,
		),
	).toEqual({ kind: "result", id: 7, value: true });
});

test("slider edits update memory while socket saves cannot bypass persistence", async () => {
	const calls: Array<{
		path: string;
		method: string;
		body: unknown;
		eventOnly: boolean;
	}> = [];
	const native = async (
		path: string,
		method: string,
		body?: unknown,
		eventOnly = false,
	) => {
		calls.push({ path, method, body, eventOnly });
		return null;
	};
	const current = state();
	const config = { camera: { mirror: true } };
	const updated = await dispatchEditorSocketCommand(
		"session-id",
		command("updateProjectConfigInMemory", [
			config,
			120,
			60,
			{ x: 960, y: 540 },
		]),
		current,
		native,
	);
	expect(updated.kind).toBe("result");
	expect(calls.map((call) => call.path)).toEqual([
		"/config/memory",
		"/preview",
	]);
	expect(calls[1]?.eventOnly).toBe(true);
	expect(calls[1]?.body).toEqual({
		frameNumber: 120,
		fps: 60,
		resolutionBase: { x: 960, y: 540 },
	});
	expect(current.frameNumber).toBe(120);
	const saved = await dispatchEditorSocketCommand(
		"session-id",
		command("setProjectConfig", [config]),
		current,
		native,
	);
	expect(saved).toMatchObject({
		kind: "error",
		error: "Editor project saves require the authenticated web API",
	});
	expect(calls).toHaveLength(2);
	const stock = await dispatchEditorSocketCommand(
		"session-id",
		command("getDefaultProjectConfig"),
		current,
		native,
	);
	expect(stock.kind).toBe("result");
	expect(calls[2]?.path).toBe("/default-config");
});

test("a Free command socket cannot load captions or preview paid caption layers", async () => {
	const calls: string[] = [];
	const native = async (path: string) => {
		calls.push(path);
		return path === "/config"
			? { captions: { segments: [{ text: "Paid" }] } }
			: null;
	};
	const free = { ...state(), captionsEnabled: false };
	expect(
		await dispatchEditorSocketCommand(
			"session-id",
			command("loadCaptions"),
			free,
			native,
		),
	).toEqual({ kind: "result", id: 7, value: null });
	expect(calls).toEqual([]);
	expect(
		await dispatchEditorSocketCommand(
			"session-id",
			command("updateProjectConfigInMemory", [
				{
					captions: {
						segments: [{ text: "Paid" }],
						settings: { enabled: true },
					},
				},
				null,
				null,
				null,
			]),
			free,
			native,
		),
	).toMatchObject({ kind: "error", error: "Cap Pro is required for captions" });
	expect(calls).toEqual([]);
	const pro = { ...state(), captionsEnabled: true };
	expect(
		await dispatchEditorSocketCommand(
			"session-id",
			command("loadCaptions"),
			pro,
			native,
		),
	).toMatchObject({
		kind: "result",
		value: { segments: [{ text: "Paid" }] },
	});
});

test("two-hour word-level captions fit the editor memory command while oversized projects are rejected", async () => {
	const words = Array.from({ length: 18_000 }, (_, index) => ({
		text: index % 7 === 0 ? "recording" : "process",
		start: index * 0.4,
		end: index * 0.4 + 0.24,
	}));
	const segments = Array.from({ length: 3_000 }, (_, index) => ({
		id: `segment-${index}`,
		start: index * 2.4,
		end: index * 2.4 + 2.24,
		text: "recording process process process process process",
		words: words.slice(index * 6, index * 6 + 6),
	}));
	const config = {
		captions: { sourceTimed: true, segments },
		timeline: { captionSegments: segments },
	};
	expect(Buffer.byteLength(JSON.stringify(config), "utf8")).toBeGreaterThan(
		512 * 1024,
	);
	const nativeConfigs: unknown[] = [];
	const native = async (_path: string, _method: string, body?: unknown) => {
		nativeConfigs.push(body);
		return body;
	};
	const current = state();
	const reply = await dispatchEditorSocketCommand(
		"session-id",
		command("updateProjectConfigInMemory", [config, null, null, null]),
		current,
		native,
	);
	expect(reply.kind).toBe("result");
	expect(current.captionCache?.ref).toHaveLength(64);
	const compact = {
		captions: { sourceTimed: true },
		timeline: {},
		webCaptionRef: current.captionCache?.ref,
	};
	expect(JSON.stringify(compact).length).toBeLessThan(
		JSON.stringify(config).length / 20,
	);
	const reused = await dispatchEditorSocketCommand(
		"session-id",
		command("updateProjectConfigInMemory", [compact, null, null, null]),
		current,
		native,
	);
	expect(reused.kind).toBe("result");
	expect(nativeConfigs[1]).toEqual(config);
	const mismatch = await dispatchEditorSocketCommand(
		"session-id",
		command("updateProjectConfigInMemory", [
			{ ...compact, webCaptionRef: "0".repeat(64) },
			null,
			null,
			null,
		]),
		current,
		native,
	);
	expect(mismatch).toMatchObject({
		kind: "error",
		error: "Caption payload cache is unavailable",
	});
	const oversized = await dispatchEditorSocketCommand(
		"session-id",
		command("updateProjectConfigInMemory", [
			{ data: "x".repeat(8 * 1024 * 1024) },
			null,
			null,
			null,
		]),
		state(),
		native,
	);
	expect(oversized.kind).toBe("error");
});

test("seek and playback reuse the current frame and reject invalid dimensions", async () => {
	const calls: Array<{ path: string; body: unknown }> = [];
	const native = async (path: string, _method: string, body?: unknown) => {
		calls.push({ path, body });
		return null;
	};
	const current = state();
	const seek = await dispatchEditorSocketCommand(
		"session-id",
		command("seekTo", [90]),
		current,
		native,
	);
	expect(seek.kind).toBe("result");
	const start = await dispatchEditorSocketCommand(
		"session-id",
		command("startPlayback", [30, { x: 640, y: 360 }]),
		current,
		native,
	);
	expect(start.kind).toBe("result");
	expect(calls[0]).toMatchObject({ path: "/seek", body: { frameNumber: 90 } });
	expect(calls[1]).toEqual({
		path: "/playback",
		body: { frameNumber: 90, fps: 30, resolutionBase: { x: 640, y: 360 } },
	});
	const invalid = await dispatchEditorSocketCommand(
		"session-id",
		command("startPlayback", [30, { x: 0, y: 360 }]),
		current,
		native,
	);
	expect(invalid.kind).toBe("error");
	expect(calls).toHaveLength(2);
});

test("gradient randomization uses the desktop gradient generator", async () => {
	const calls: string[] = [];
	const gradient = { colorStops: [{ color: "#fff", position: 0 }] };
	const native = async (path: string) => {
		calls.push(path);
		return gradient;
	};
	const reply = await dispatchEditorSocketCommand(
		"session-id",
		command("randomAnimatedGradient"),
		state(),
		native,
	);
	expect(reply).toEqual({ kind: "result", id: 7, value: gradient });
	expect(calls).toEqual(["/animated-gradients/random"]);
});

test("keyboard generation uses the native project timeline and rejects invalid settings", async () => {
	const calls: Array<{ path: string; method: string; body: unknown }> = [];
	const native = async (path: string, method: string, body?: unknown) => {
		calls.push({ path, method, body });
		return [{ start: 0.5, end: 1.25, text: "A" }];
	};
	const reply = await dispatchEditorSocketCommand(
		"session-id",
		command("generateKeyboardSegments", [350, 1800, true, false]),
		state(),
		native,
	);
	expect(reply).toEqual({
		kind: "result",
		id: 7,
		value: [{ start: 0.5, end: 1.25, text: "A" }],
	});
	expect(calls).toEqual([
		{
			path: "/keyboard-segments",
			method: "POST",
			body: {
				groupingThresholdMs: 350,
				lingerDurationMs: 1800,
				showModifiers: true,
				showSpecialKeys: false,
			},
		},
	]);
	const rejected = await dispatchEditorSocketCommand(
		"session-id",
		command("generateKeyboardSegments", [-1, 1800, true, false]),
		state(),
		native,
	);
	expect(rejected.kind).toBe("error");
	expect(calls).toHaveLength(1);
});

test("auto zoom generation passes the saved zoom amount to the native cursor timeline", async () => {
	const calls: Array<{ path: string; body: unknown }> = [];
	const native = async (path: string, _method: string, body?: unknown) => {
		calls.push({ path, body });
		return [{ start: 0.9, end: 6.7, amount: 1.8 }];
	};
	const reply = await dispatchEditorSocketCommand(
		"session-id",
		command("generateZoomSegmentsFromClicks", [1.8]),
		state(),
		native,
	);
	expect(reply).toMatchObject({ kind: "result", value: [{ amount: 1.8 }] });
	expect(calls).toEqual([
		{ path: "/auto-zoom-segments", body: { zoomAmount: 1.8 } },
	]);
	const invalid = await dispatchEditorSocketCommand(
		"session-id",
		command("generateZoomSegmentsFromClicks", [Infinity]),
		state(),
		native,
	);
	expect(invalid.kind).toBe("error");
	expect(calls).toHaveLength(1);
});
