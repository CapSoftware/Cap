import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [
	bundle,
	fixtureDirectory,
	outputPrefix,
	padding = "128",
	executablePath,
	playwrightModule,
] = process.argv.slice(2);
if (
	!bundle ||
	!fixtureDirectory ||
	!outputPrefix ||
	!executablePath ||
	!playwrightModule
) {
	throw new Error(
		"Usage: node benchmark-loom-dash-memory.mjs BUNDLE FIXTURES OUTPUT_PREFIX PADDING_MIB CHROMIUM PLAYWRIGHT_MODULE",
	);
}
const paddingMiB = Number(padding);
if (!Number.isInteger(paddingMiB) || paddingMiB < 0 || paddingMiB > 128)
	throw new Error("PADDING_MIB must be an integer between 0 and 128");
if (process.platform !== "linux")
	throw new Error("PSS sampling requires Linux /proc");
const { chromium } = await import(
	pathToFileURL(resolve(playwrightModule)).href
);
const bundleSha256 = createHash("sha256")
	.update(await readFile(bundle))
	.digest("hex");
const fixtures = {};
for (const name of [
	"manifest.mpd",
	"init.webm",
	"segment-1.webm",
	"segment-2.webm",
]) {
	const bytes = await readFile(resolve(fixtureDirectory, name));
	fixtures[name] = name.endsWith(".mpd")
		? bytes.toString()
		: bytes.toString("base64");
}
const samples = [];
const browser = await chromium.launch({
	executablePath,
	headless: true,
	args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
	const page = await browser.newPage();
	await page.goto("https://example.com");
	await page.addScriptTag({ path: resolve(bundle) });
	const cdp = await browser.newBrowserCDPSession();
	let polling = false;
	let samplingError;
	const sample = async () => {
		if (polling) return;
		polling = true;
		try {
			const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
			const memory = await Promise.all(
				processInfo.map(async ({ id }) => {
					try {
						return Number(
							(await readFile(`/proc/${id}/smaps_rollup`, "utf8")).match(
								/^Pss:\s+(\d+) kB$/m,
							)?.[1] ?? 0,
						);
					} catch (error) {
						if (error.code === "ENOENT" || error.code === "ESRCH") return 0;
						throw error;
					}
				}),
			);
			samples.push({
				time: performance.now(),
				pssKiB: memory.reduce((a, b) => a + b, 0),
			});
		} catch (error) {
			samplingError = error;
		} finally {
			polling = false;
		}
	};
	await sample();
	const timer = setInterval(() => {
		void sample();
	}, 20);
	let outcome;
	const start = performance.now();
	try {
		outcome = await page.evaluate(
			async ({ fixtures, paddingMiB }) => {
				const decode = (base64) =>
					Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
				const resources = [];
				globalThis.fetch = async (input) => {
					const name = String(input).split("/").at(-1);
					resources.push(name);
					if (name === "manifest.mpd") return new Response(fixtures[name]);
					const original = decode(fixtures[name]);
					let remaining =
						name === "segment-2.webm" ? paddingMiB * 1024 * 1024 : 0;
					const size = remaining;
					let first = true;
					const stream = new ReadableStream({
						pull(controller) {
							if (first) {
								first = false;
								controller.enqueue(original);
								if (remaining) {
									const header = new Uint8Array(5);
									header[0] = 0xec;
									new DataView(header.buffer).setUint32(1, 0x10000000 + size);
									controller.enqueue(header);
								}
							} else if (remaining > 0) {
								const count = Math.min(1024 * 1024, remaining);
								remaining -= count;
								controller.enqueue(new Uint8Array(count));
							} else controller.close();
						},
					});
					return new Response(stream, {
						headers: { "content-type": "video/webm" },
					});
				};
				const progress = [];
				const blob = await globalThis.convertFixture({
					url: "https://example.com/fixture/manifest.mpd",
					filename: "fixture.mp4",
					onProgress: (value) => progress.push(value),
				});
				if (!blob) throw new Error("No output");
				return {
					bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
					resources,
					lastProgress: progress.at(-1),
				};
			},
			{ fixtures, paddingMiB },
		);
	} finally {
		clearInterval(timer);
	}
	while (polling) await new Promise((resolve) => setImmediate(resolve));
	await sample();
	const elapsedMs = performance.now() - start;
	if (samplingError) throw samplingError;
	const bytes = Buffer.from(outcome.bytes);
	await writeFile(`${outputPrefix}.mp4`, bytes);
	const record = {
		bundle: resolve(bundle),
		bundleSha256,
		paddingMiB,
		elapsedMs,
		outputBytes: bytes.length,
		resources: outcome.resources,
		lastProgress: outcome.lastProgress,
		sampledPeakPssMiB: Math.max(...samples.map((x) => x.pssKiB)) / 1024,
		samples,
	};
	const path = `${outputPrefix}.json`;
	await writeFile(path, JSON.stringify(record));
	console.log(JSON.stringify({ ...record, samples: samples.length }));
} finally {
	await browser.close();
}
