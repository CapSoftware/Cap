import { expect, test } from "vitest";
import {
	isAbandonedEditorReplacementUpload,
	isActiveEditorReplacementUpload,
} from "../lib/editor-replacement-upload";

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

test("a replacement upload that stopped moving no longer blocks editing", () => {
	const minutesAgo = (minutes: number) =>
		new Date(Date.now() - minutes * 60 * 1000);
	expect(
		isAbandonedEditorReplacementUpload(
			"owner",
			"video",
			"uploading",
			key,
			minutesAgo(11),
		),
	).toBe(true);
	expect(
		isAbandonedEditorReplacementUpload(
			"owner",
			"video",
			"uploading",
			key,
			minutesAgo(2),
		),
	).toBe(false);
	expect(
		isAbandonedEditorReplacementUpload(
			"owner",
			"video",
			"uploading",
			"owner/video/raw-upload.mp4",
			minutesAgo(60),
		),
	).toBe(false);
	expect(
		isAbandonedEditorReplacementUpload(
			"owner",
			"video",
			"uploading",
			key,
			null,
		),
	).toBe(false);
});
