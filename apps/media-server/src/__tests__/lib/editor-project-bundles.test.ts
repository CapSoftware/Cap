import { afterAll, afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	CAP_BUNDLE_HEADER_BYTES,
	parseCapBundleManifest,
	readCapBundleManifestLength,
} from "@cap/editor-cap-bundle";
import { extractEditorCapBundle } from "../../lib/editor-cap-bundle";
import {
	consumeEditorProjectBundleDownloadTicket,
	createEditorProjectBundleDownloadTicket,
	editorProjectBundleResponse,
} from "../../lib/editor-project-bundles";

const previousOrigin = process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN = "http://127.0.0.1:43017";
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

afterAll(() => {
	if (previousOrigin === undefined)
		delete process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
	else process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN = previousOrigin;
});

async function makeProject() {
	const root = await mkdtemp(join(tmpdir(), "cap-bundle-test-"));
	roots.push(root);
	const project = join(root, "source.cap");
	await mkdir(join(project, "content/segments/segment-0"), {
		recursive: true,
	});
	await mkdir(join(project, "assets/audio"), { recursive: true });
	await mkdir(join(project, "screenshots"), { recursive: true });
	const metadata = Buffer.from(
		JSON.stringify({ prettyName: "Test recording" }),
	);
	const config = Buffer.from(
		JSON.stringify({ background: { source: "none" } }),
	);
	const video = Buffer.alloc(3 * 1024 * 1024, 0x37);
	const audio = Buffer.alloc(1024 * 1024, 0x52);
	const screenshot = Buffer.alloc(10_000, 0x29);
	await Promise.all([
		writeFile(join(project, "recording-meta.json"), metadata),
		writeFile(join(project, "project-config.json"), config),
		writeFile(join(project, "content/segments/segment-0/display.mp4"), video),
		writeFile(join(project, "assets/audio/import-test.mp3"), audio),
		writeFile(join(project, "screenshots/preview.jpg"), screenshot),
	]);
	return { project, metadata, config, video, audio, screenshot };
}

describe("editor project bundle downloads", () => {
	test("streams a portable snapshot after the editor project closes", async () => {
		const { project, metadata, config, video, audio, screenshot } =
			await makeProject();
		const created = await createEditorProjectBundleDownloadTicket(
			"session-test",
			project,
			"Test recording.capbundle",
		);
		const url = new URL(created.url);
		assert.equal(
			url.pathname,
			"/editor/sessions/session-test/project-bundle/download",
		);
		const token = url.searchParams.get("ticket");
		const ticket = consumeEditorProjectBundleDownloadTicket(
			"session-test",
			token,
		);
		assert.ok(ticket);
		assert.equal(
			consumeEditorProjectBundleDownloadTicket("session-test", token),
			null,
		);
		const snapshotConfig = await readFile(
			join(ticket.root, "project-config.json"),
		);
		assert.deepEqual(snapshotConfig, config);
		await writeFile(
			join(project, "project-config.json"),
			"updated after snapshot",
		);
		await rm(project, { recursive: true, force: true });
		const response = editorProjectBundleResponse(ticket);
		assert.equal(response.headers.get("Content-Length"), String(ticket.size));
		assert.match(
			response.headers.get("Content-Disposition") ?? "",
			/Test recording\.capbundle/,
		);
		const bytes = Buffer.from(await response.arrayBuffer());
		assert.equal(bytes.length, ticket.size);
		const length = readCapBundleManifestLength(
			bytes.subarray(0, CAP_BUNDLE_HEADER_BYTES),
		);
		assert.ok(length);
		const manifest = parseCapBundleManifest(
			bytes.subarray(CAP_BUNDLE_HEADER_BYTES, CAP_BUNDLE_HEADER_BYTES + length),
			bytes.length,
		);
		assert.ok(manifest);
		const expected = new Map([
			["recording-meta.json", metadata],
			["project-config.json", config],
			["content/segments/segment-0/display.mp4", video],
			["assets/audio/import-test.mp3", audio],
			["screenshots/preview.jpg", screenshot],
		]);
		for (const file of manifest.files) {
			const original = expected.get(file.path);
			assert.ok(original);
			const start: number = CAP_BUNDLE_HEADER_BYTES + length + file.offset;
			assert.deepEqual(bytes.subarray(start, start + file.size), original);
		}
		assert.equal(manifest.files.length, expected.size);
		const archivePath = join(dirname(project), "export.capbundle");
		await writeFile(archivePath, bytes);
		const extracted = await extractEditorCapBundle(archivePath);
		try {
			for (const [path, original] of expected)
				assert.deepEqual(await readFile(join(extracted.path, path)), original);
		} finally {
			await extracted.cleanup();
		}
		await assert.rejects(readFile(join(ticket.root, "recording-meta.json")));
	});

	test("rejects symlinks in project media", async () => {
		const { project } = await makeProject();
		await symlink(
			join(project, "recording-meta.json"),
			join(project, "content/segments/segment-0/unsafe.json"),
		);
		await assert.rejects(
			createEditorProjectBundleDownloadTicket("session-test", project),
			/unsupported file/,
		);
	});
});
