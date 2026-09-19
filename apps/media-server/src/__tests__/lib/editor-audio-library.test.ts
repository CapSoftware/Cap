import { expect, test } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addEditorAudioLibraryTrack,
	listEditorAudioLibrary,
	stageSavedEditorAudioLibrary,
} from "../../lib/editor-audio-library";

test("the bundled desktop music can be added and restored on reopening", async () => {
	const catalog = listEditorAudioLibrary();
	expect(catalog).toHaveLength(10);
	expect(catalog[0]).toEqual({
		id: "lofi-beats-mirostar",
		name: "Lofi Beats",
		category: "Lo-Fi",
	});
	const projectPath = await mkdtemp(join(tmpdir(), "cap-editor-music-test-"));
	try {
		const added = await addEditorAudioLibraryTrack(
			projectPath,
			"lofi-beats-mirostar",
		);
		expect(added.path).toBe("assets/audio/library-lofi-beats-mirostar.mp3");
		expect(added.name).toBe("Lofi Beats");
		expect(added.duration).toBeGreaterThan(30);
		const stagedPath = join(projectPath, added.path);
		const first = await lstat(stagedPath);
		expect(first.size).toBeGreaterThan(100_000);
		await rm(stagedPath);
		await stageSavedEditorAudioLibrary(projectPath, {
			timeline: {
				audioSegments: [
					{ path: added.path },
					{ path: added.path },
					{ path: "assets/audio/library-foreign.mp3" },
				],
			},
		});
		const restored = await lstat(stagedPath);
		expect(restored.size).toBe(first.size);
		expect(
			addEditorAudioLibraryTrack(projectPath, "../../recording"),
		).rejects.toThrow("Unknown library track");
	} finally {
		await rm(projectPath, { recursive: true, force: true });
	}
});
