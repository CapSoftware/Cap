import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_GENERATION_LANGUAGE_CODES } from "@cap/web-domain";
import { describe, expect, it } from "vitest";
import { developerOpenApiSpec } from "@/lib/developer-openapi";
import {
	TRANSCRIPT_FAILURE_CODES,
	TRANSCRIPT_REQUEST_ERRORS,
} from "@/lib/developer-transcript-errors";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const docs = read("content/docs/api/rest-api.mdx");
const transcriptDocs = docs.slice(
	docs.indexOf("### Transcripts"),
	docs.indexOf("### Get Usage"),
);
const spec = developerOpenApiSpec("https://cap.so");
const specText = JSON.stringify(spec);
const schemas = spec.components.schemas as Record<
	string,
	{ properties?: Record<string, { enum?: unknown[]; description?: string }> }
>;

const REQUEST_SOURCES = [
	"lib/developer-transcript-store.ts",
	"lib/developer-transcript-billing.ts",
	"app/api/developer/v1/[...route]/transcripts.ts",
];

const codesIn = (source: string) => {
	const found = new Set<string>();
	for (const match of source.matchAll(
		/(?:fail|apiErrorBody)\(\s*(?:\d{3},\s*)?(?:[a-zA-Z.]+ === "[a-z_]+"\s*\?\s*)?"([a-z_]+)"(?:\s*:\s*"([a-z_]+)")?/g,
	)) {
		for (const code of [match[1], match[2]]) if (code) found.add(code);
	}
	for (const match of source.matchAll(/code: "([a-z_]+)"/g)) {
		if (match[1]) found.add(match[1]);
	}
	return found;
};

describe("transcript error codes", () => {
	const listed = new Set<string>(
		TRANSCRIPT_REQUEST_ERRORS.map((error) => error.code),
	);

	it("lists every code the transcript routes can answer with", () => {
		const returned = new Set<string>();
		for (const path of REQUEST_SOURCES) {
			for (const code of codesIn(read(path))) returned.add(code);
		}
		expect(returned.size).toBeGreaterThan(15);
		expect([...returned].filter((code) => !listed.has(code)).sort()).toEqual(
			[],
		);
		expect([...listed].filter((code) => !returned.has(code)).sort()).toEqual(
			[],
		);
	});

	it("lists every code a failed transcript can carry", () => {
		const type = read("lib/developer-transcripts.ts");
		const union = type.slice(
			type.indexOf("export type TranscriptErrorCode"),
			type.indexOf("export type TranscriptWord"),
		);
		const declared = [...union.matchAll(/"([a-z_]+)"/g)].map(
			(match) => match[1],
		);
		expect(declared.length).toBeGreaterThan(8);
		expect(
			TRANSCRIPT_FAILURE_CODES.map((failure) => failure.code).sort(),
		).toEqual([...declared].sort());
	});

	it("documents every code in the transcript section of the docs", () => {
		const missing = [
			...TRANSCRIPT_REQUEST_ERRORS.map((error) => error.code),
			...TRANSCRIPT_FAILURE_CODES.map((failure) => failure.code),
		].filter((code) => !transcriptDocs.includes(`\`${code}\``));
		expect(missing).toEqual([]);
	});

	it("gives each request error its status in the docs table", () => {
		for (const error of TRANSCRIPT_REQUEST_ERRORS) {
			expect(transcriptDocs).toContain(
				`| \`${error.status}\` | \`${error.code}\` |`,
			);
		}
	});

	it("documents every code in the OpenAPI description", () => {
		const missing = [
			...TRANSCRIPT_REQUEST_ERRORS.map((error) => error.code),
			...TRANSCRIPT_FAILURE_CODES.map((failure) => failure.code),
		].filter((code) => !specText.includes(code));
		expect(missing).toEqual([]);
		expect(schemas.Transcript?.properties?.error).toBeDefined();
	});
});

describe("the language parameter", () => {
	it("is described by the codes the API accepts", () => {
		const language = schemas.CreateTranscriptRequest?.properties?.language;
		expect(language?.enum).toEqual(["auto", ...AI_GENERATION_LANGUAGE_CODES]);
		expect(
			schemas.CreateTranscriptUploadRequest?.properties?.language?.enum,
		).toEqual(["auto", ...AI_GENERATION_LANGUAGE_CODES]);
	});

	it("says what a code does and does not do", () => {
		const request =
			schemas.CreateTranscriptRequest?.properties?.language?.description ?? "";
		expect(request).toContain("skips language detection");
		expect(request).toContain("does not translate");
		const reported =
			schemas.Transcript?.properties?.language?.description ?? "";
		expect(reported).toContain("the code sent in the request");
		expect(reported).toContain("detected");
		expect(transcriptDocs).toContain("#### Languages");
		expect(transcriptDocs).toContain(
			"does not check the code against the audio",
		);
	});

	it("lists every supported code in the docs", () => {
		const missing = AI_GENERATION_LANGUAGE_CODES.filter(
			(code) => !transcriptDocs.includes(`\`${code}\` `),
		);
		expect(missing).toEqual([]);
	});
});

describe("transcript docs keep up with the API", () => {
	it("states the characters an Idempotency-Key may contain", () => {
		expect(transcriptDocs).toContain(
			"letters, digits, dot, dash and underscore",
		);
		expect(specText).toContain("^[A-Za-z0-9._-]+$");
	});

	it("does not offer a word confidence", () => {
		expect(transcriptDocs).not.toContain("confidence");
		expect(JSON.stringify(schemas.TranscriptDetail)).not.toContain(
			"confidence",
		);
		expect(transcriptDocs).toContain("steps of 0.08 seconds");
	});

	it("states the download limit and the upload expiry", () => {
		expect(transcriptDocs).toContain("within 15 minutes");
		expect(transcriptDocs).toContain("upload.expiresAt");
		expect(transcriptDocs).toContain("SignatureDoesNotMatch");
	});

	it("describes the usage fields for speech", () => {
		const usage = schemas.Usage?.properties ?? {};
		expect(Object.keys(usage)).toEqual(
			expect.arrayContaining([
				"availableMicroCredits",
				"heldMicroCredits",
				"speech",
			]),
		);
		expect(docs).toContain('"heldMicroCredits"');
	});
});
