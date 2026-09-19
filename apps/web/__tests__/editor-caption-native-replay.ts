import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { VideoMetadata } from "@cap/database/types";
import { buildEditorCaptionSourcePlan } from "../lib/editor-caption-sources";

const fixturePath = process.argv[2];
assert.ok(fixturePath);
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
	metadata: VideoMetadata;
	instance: unknown;
};
const plan = buildEditorCaptionSourcePlan(
	"owner",
	"video",
	fixture.metadata,
	fixture.instance,
	"worker-a",
);
assert.ok(plan);
assert.equal(plan.sources.length, 4);
assert.deepEqual(
	plan.sources.map((source) => source.cap?.clipCount ?? 0),
	[0, 2, 0, 1],
);
const studioSegments = plan.sources[1]?.cap?.segments;
assert.ok(studioSegments);
assert.deepEqual(
	studioSegments.map((segment) => segment.hasAudio),
	[true, true],
);
process.stdout.write(`${JSON.stringify({ studioSegments })}\n`);
