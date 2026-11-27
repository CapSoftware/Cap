import { afterEach, expect, test, vi } from "vitest";
import { EditorHostBridge } from "../../app/s/[videoId]/edit/studio/editor-host";
import {
	importWebEditorVideo,
	registerWebEditorClip,
} from "../../lib/editor-video-import-client";

vi.mock("@/lib/editor-video-import-client", () => ({
	CAP_BUNDLE_UNSUPPORTED: "unsupported",
	isCapBundleFile: () => false,
	importWebEditorVideo: vi.fn(),
	registerWebEditorClip: vi.fn(),
}));

const displayPath = "content/videos/00000000-0000-0000-0000-000000000001.webm";
const cameraPath = "content/videos/00000000-0000-0000-0000-000000000002.webm";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.mocked(importWebEditorVideo).mockReset();
	vi.mocked(registerWebEditorClip).mockReset();
});

function host(options: { savedAt: string | null }) {
	return new EditorHostBridge({
		videoId: "recording",
		userId: "owner",
		captionsEnabled: true,
		onClose: vi.fn(),
		onFailure: vi.fn(),
		getProjectSavedAt: () => options.savedAt,
		getUnsavedProject: () => ({ timeline: null }),
	});
}

test("a recorded screen and camera register as one synchronized clip, uploading each once", async () => {
	const screen = new File(["screen"], "screen.webm", { type: "video/webm" });
	const camera = new File(["camera"], "camera.webm", { type: "video/webm" });
	const staged = vi.mocked(importWebEditorVideo);
	staged.mockImplementation(async (file) => ({
		path: file === screen ? displayPath : cameraPath,
		name: file.name,
		duration: 3,
		fps: file === screen ? 30 : 25,
		width: 640,
		height: 360,
		hasAudio: file === screen,
	}));
	const register = vi.mocked(registerWebEditorClip);
	register.mockRejectedValueOnce(
		new Error("Editor changed while importing the clip. Try again."),
	);
	const bridge = host({ savedAt: "2026-11-23T00:00:00.000Z" });
	await expect(bridge.addRecordedClip(screen, camera, 125)).rejects.toThrow(
		"Editor changed while importing the clip",
	);
	await bridge.addRecordedClip(screen, camera, 125);
	expect(staged.mock.calls.map(([file]) => file)).toEqual([screen, camera]);
	expect(register).toHaveBeenCalledTimes(2);
	const [videoId, display, cameraClip, , projectConfig] =
		register.mock.calls[1] ?? [];
	expect(videoId).toBe("recording");
	expect(display?.path).toBe(displayPath);
	expect(cameraClip?.video.path).toBe(cameraPath);
	expect(cameraClip?.offsetMs).toBe(125);
	expect(projectConfig).toBeNull();
	bridge.dispose();
});

test("a never-saved project sends the editor's project with its first clip", async () => {
	const screen = new File(["screen"], "screen.webm", { type: "video/webm" });
	vi.mocked(importWebEditorVideo).mockResolvedValue({
		path: displayPath,
		name: "screen",
		duration: 3,
		fps: 30,
		width: 640,
		height: 360,
		hasAudio: true,
	});
	const bridge = host({ savedAt: null });
	await bridge.addRecordedClip(screen, null, 0);
	expect(vi.mocked(registerWebEditorClip).mock.calls[0]?.[4]).toEqual({
		timeline: null,
	});
	bridge.dispose();
});
