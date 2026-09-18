import { expect, test } from "vitest";
import { isActiveEditorReplacementUpload } from "../lib/editor-session";

const key =
	"owner/video/.recording/outputs/reupload-123e4567-e89b-42d3-a456-426614174000/result.mp4";

test("only the current owned replacement upload may keep an editor session readable", () => {
	expect(
		isActiveEditorReplacementUpload("owner", "video", "uploading", key),
	).toBe(true);
	expect(
		isActiveEditorReplacementUpload("other", "video", "uploading", key),
	).toBe(false);
	expect(
		isActiveEditorReplacementUpload("owner", "other", "uploading", key),
	).toBe(false);
	expect(
		isActiveEditorReplacementUpload("owner", "video", "processing", key),
	).toBe(false);
	expect(
		isActiveEditorReplacementUpload(
			"owner",
			"video",
			"uploading",
			"owner/video/.recording/outputs/edit-123e4567-e89b-42d3-a456-426614174000/result.mp4",
		),
	).toBe(false);
	expect(
		isActiveEditorReplacementUpload(
			"owner",
			"video",
			"uploading",
			`${key}/../camera.webm`,
		),
	).toBe(false);
});
