import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { createAudioQualityCandidate } from "../src/lib/audio-quality";

const [root, split, label, profile] = process.argv.slice(2);
if (
	!root ||
	!isAbsolute(root) ||
	!["tuning", "holdout"].includes(split) ||
	!label ||
	!/^[a-z0-9-]+$/.test(label) ||
	(profile !== "levels" && profile !== "voice")
)
	throw new Error(
		"Usage: benchmark-audio-quality.ts ABS_ROOT tuning|holdout LABEL levels|voice",
	);

const rows = z
	.array(
		z.object({
			id: z.string().regex(/^[a-z0-9]{15}$/),
			split: z.enum(["tuning", "holdout"]),
		}),
	)
	.parse(JSON.parse(await readFile(join(root, "cohort.json"), "utf8")))
	.filter((row) => row.split === split);
const destination = join(root, label);
await mkdir(destination);
const codeHash = createHash("sha256")
	.update(
		await readFile(new URL("../src/lib/audio-quality.ts", import.meta.url)),
	)
	.update(
		await readFile(
			new URL("../src/lib/audio-quality-policy.ts", import.meta.url),
		),
	)
	.digest("hex");
await writeFile(
	join(destination, "run.json"),
	JSON.stringify(
		{
			split,
			profile,
			codeHash,
			count: rows.length,
			forcedContentGateForOfflineExperiment: profile === "voice",
			startedAt: new Date().toISOString(),
		},
		null,
		2,
	),
	{ flag: "wx" },
);
let next = 0;
const results: Record<string, unknown>[] = [];
async function worker() {
	for (;;) {
		const row = rows[next++];
		if (!row) return;
		const started = performance.now();
		let receipt: Record<string, unknown>;
		try {
			const result = await createAudioQualityCandidate(
				join(root, "sources", `${row.id}.m4a`),
				{
					mode: "shadow",
					profile: profile as "levels" | "voice",
					speechOnlyConfirmed: profile === "voice",
				},
			);
			if (result.status === "shadow-candidate") {
				try {
					await copyFile(result.path, join(destination, `${row.id}.mp4`), 1);
					const { cleanup: _cleanup, path: _path, ...evidence } = result;
					receipt = { id: row.id, ...evidence, codeHash };
				} finally {
					await result.cleanup();
				}
			} else receipt = { id: row.id, ...result, codeHash };
		} catch (error) {
			receipt = {
				id: row.id,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				codeHash,
			};
		}
		receipt.wallMs = performance.now() - started;
		await writeFile(
			join(destination, `${row.id}.json`),
			JSON.stringify(receipt, null, 2),
			{ flag: "wx" },
		);
		results.push(receipt);
		console.log(JSON.stringify(receipt));
	}
}
await Promise.all([worker(), worker()]);
await writeFile(
	join(destination, "results.json"),
	JSON.stringify(results, null, 2),
	{ flag: "wx" },
);
if (results.some((result) => result.status === "failed")) process.exitCode = 1;
