import { afterEach, expect, test, vi } from "vitest";
import { EditorHostBridge } from "../../app/s/[videoId]/edit/studio/editor-host";
import { importWebEditorVideo } from "../../lib/editor-video-import-client";

vi.mock("@/lib/editor-video-import-client", () => ({
	importWebEditorVideo: vi.fn(),
}));

const displayPath = "content/videos/00000000-0000-0000-0000-000000000001.webm";
const cameraPath = "content/videos/00000000-0000-0000-0000-000000000002.webm";
const displayJobId = "00000000-0000-0000-0000-000000000003";
const cameraJobId = "00000000-0000-0000-0000-000000000004";

afterEach(() => vi.unstubAllGlobals());

test("a recorded screen and camera register as one synchronized editor clip", async () => {
	const screen = new File(["screen"], "screen.webm", { type: "video/webm" });
	const camera = new File(["camera"], "camera.webm", { type: "video/webm" });
	const staged = vi.mocked(importWebEditorVideo);
	staged.mockImplementation(async (file) => ({
		jobId: file === screen ? displayJobId : cameraJobId,
		path: file === screen ? displayPath : cameraPath,
		name: file.name,
		duration: 3,
		fps: file === screen ? 30 : 25,
		width: 640,
		height: 360,
		hasAudio: file === screen,
	}));
	const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
	let registrationStatus = 409;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			requests.push({
				url,
				body: JSON.parse(String(init.body)) as Record<string, unknown>,
			});
			return registrationStatus === 409
				? new Response(null, { status: 409 })
				: Response.json({ count: 1 });
		}),
	);
	const bridge = new EditorHostBridge(
		"recording",
		"session",
		"owner",
		vi.fn(),
		vi.fn(),
	);
	await expect(bridge.addRecordedClip(screen, camera, 125)).rejects.toThrow(
		"Editor changed while importing the clip",
	);
	registrationStatus = 200;
	await bridge.addRecordedClip(screen, camera, 125);
	expect(staged).toHaveBeenCalledTimes(2);
	expect(staged.mock.calls.map(([file]) => file)).toEqual([screen, camera]);
	expect(requests).toHaveLength(2);
	expect(requests[1]).toEqual({
		url: "/api/editor/sessions/session/clips",
		body: {
			videoId: "recording",
			path: displayPath,
			jobId: displayJobId,
			camera: { path: cameraPath, jobId: cameraJobId, offsetMs: 125 },
		},
	});
	bridge.dispose();
});
