import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { developerOpenApiSpec } from "@/lib/developer-openapi";
import {
	INFRA_SUPPORTED_VIDEO_FORMATS,
	INFRA_UPLOAD_CONTENT_TYPES,
	INFRA_VIDEO_FILE_ACCEPT,
	isRefusedUploadContentType,
} from "@/lib/infra-video-formats";

const SENTENCE =
	"MP4, MOV, MKV and WebM files with H.264, HEVC, VP8, VP9, AV1, ProRes, MPEG-4 or Motion JPEG video";

const doc = (name: string) =>
	fs.readFileSync(
		path.join(process.cwd(), "content/docs/api", `${name}.mdx`),
		"utf8",
	);

describe("supported video formats", () => {
	it("is one sentence, word for word", () => {
		expect(INFRA_SUPPORTED_VIDEO_FORMATS).toBe(SENTENCE);
	});

	it.each(["rest-api", "get-started"])("appears verbatim in %s.mdx", (name) => {
		expect(doc(name)).toContain(SENTENCE);
	});

	it("puts the note under Create Upload in the reference", () => {
		const reference = doc("rest-api");
		const createUpload = reference.indexOf("### Create Upload");
		const note = reference.indexOf(`Cap Infra accepts ${SENTENCE}.`);
		const nextSection = reference.indexOf("\n### ", createUpload + 1);
		expect(createUpload).toBeGreaterThan(-1);
		expect(note).toBeGreaterThan(createUpload);
		expect(note).toBeLessThan(nextSection);
	});

	it("no longer offers AVI as an upload content type", () => {
		expect(INFRA_UPLOAD_CONTENT_TYPES).not.toContain("video/avi");
		expect(doc("rest-api")).not.toMatch(/`video\/x-matroska`, `video\/avi`/);
		expect(isRefusedUploadContentType("video/avi")).toBe(true);
		expect(isRefusedUploadContentType("video/webm;codecs=vp9")).toBe(false);
		expect(isRefusedUploadContentType(undefined)).toBe(false);
	});

	it("lists the same content types in the OpenAPI enum", () => {
		const spec = developerOpenApiSpec("https://cap.so") as unknown as {
			components: {
				schemas: {
					InitiateUploadRequest: {
						properties: { contentType: { enum: string[] } };
					};
				};
			};
		};
		expect(
			spec.components.schemas.InitiateUploadRequest.properties.contentType.enum,
		).toEqual([...INFRA_UPLOAD_CONTENT_TYPES]);
	});

	it("lets the file picker choose only those containers", () => {
		expect(INFRA_VIDEO_FILE_ACCEPT.split(",")).toEqual([
			".mp4",
			".mov",
			".mkv",
			".webm",
			"video/mp4",
			"video/quicktime",
			"video/x-matroska",
			"video/webm",
		]);
		expect(INFRA_VIDEO_FILE_ACCEPT).not.toContain("video/*");
	});
});
