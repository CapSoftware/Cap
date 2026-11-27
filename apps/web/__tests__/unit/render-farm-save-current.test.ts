import type { VideoMetadata } from "@cap/database/types";
import { expect, test } from "vitest";
import {
	renderFarmSaveIsCurrent,
	savedProjectIsPublished,
} from "@/lib/render-farm-status";

const save = (
	status: "rendering" | "published" | "error",
	projectSavedAt?: string | null,
) => ({
	version: 1 as const,
	exportId: "export",
	jobId: "job",
	status,
	projectSavedAt,
	startedAt: "2026-09-28T00:00:00.000Z",
	outputKey: "owner/video/output.mp4",
	hlsPrefix: "owner/video/hls/",
});

const project = (savedAt: string) =>
	({ version: 1, config: {}, savedAt }) as VideoMetadata["webEditorProject"];

test("a render of the project as saved now is current", () => {
	expect(
		renderFarmSaveIsCurrent({
			renderFarmSave: save("published", "a"),
			webEditorProject: project("a"),
		}),
	).toBe(true);
	expect(
		renderFarmSaveIsCurrent({
			renderFarmSave: save("rendering", "a"),
			webEditorProject: project("a"),
		}),
	).toBe(true);
	expect(
		renderFarmSaveIsCurrent({ renderFarmSave: save("published", null) }),
	).toBe(true);
});

test("edits, failures and older renders can be saved again", () => {
	expect(
		renderFarmSaveIsCurrent({
			renderFarmSave: save("published", "a"),
			webEditorProject: project("b"),
		}),
	).toBe(false);
	expect(
		renderFarmSaveIsCurrent({
			renderFarmSave: save("published", null),
			webEditorProject: project("a"),
		}),
	).toBe(false);
	expect(
		renderFarmSaveIsCurrent({
			renderFarmSave: save("error", "a"),
			webEditorProject: project("a"),
		}),
	).toBe(false);
	expect(renderFarmSaveIsCurrent({ renderFarmSave: save("published") })).toBe(
		false,
	);
	expect(renderFarmSaveIsCurrent(null)).toBe(false);
});

test("a published browser Save of the project as saved now is current", () => {
	const browser = (
		status: "rendering" | "published" | "error",
		projectSavedAt: string | null,
	) => ({
		version: 1 as const,
		saveId: "11111111-1111-4111-8111-111111111111",
		status,
		projectSavedAt,
		progress: status === "published" ? 1 : 0.5,
		startedAt: "2026-09-29T00:00:00.000Z",
		updatedAt: "2026-09-29T00:01:00.000Z",
	});
	expect(
		renderFarmSaveIsCurrent({
			webEditorBrowserSave: browser("published", "a"),
			webEditorProject: project("a"),
		}),
	).toBe(true);
	expect(
		renderFarmSaveIsCurrent({
			webEditorBrowserSave: browser("rendering", "a"),
			webEditorProject: project("a"),
		}),
	).toBe(false);
	expect(
		renderFarmSaveIsCurrent({
			webEditorBrowserSave: browser("published", "a"),
			webEditorProject: project("b"),
		}),
	).toBe(false);
});

test("a browser Save can take over a farm render of the same project", () => {
	const rendering = {
		renderFarmSave: save("rendering", "a"),
		webEditorProject: project("a"),
	};
	expect(renderFarmSaveIsCurrent(rendering)).toBe(true);
	expect(savedProjectIsPublished(rendering)).toBe(false);
	expect(
		savedProjectIsPublished({
			renderFarmSave: save("error", "a"),
			webEditorProject: project("a"),
		}),
	).toBe(false);
	expect(
		savedProjectIsPublished({
			renderFarmSave: save("published", "a"),
			webEditorProject: project("a"),
		}),
	).toBe(true);
	expect(
		savedProjectIsPublished({
			renderFarmSave: save("published", "a"),
			webEditorProject: project("b"),
		}),
	).toBe(false);
	expect(savedProjectIsPublished(null)).toBe(false);
});
