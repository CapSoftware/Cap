import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getContainerMemoryMetrics } from "../../lib/container-memory";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("container memory metrics", () => {
	test("reads cgroup usage and limit values", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cap-container-memory-"));
		tempDirs.push(dir);
		const limitPath = join(dir, "memory.max");
		const usagePath = join(dir, "memory.current");
		await writeFile(limitPath, String(1024 * 1024 * 1000));
		await writeFile(usagePath, String(1024 * 1024 * 750));

		const metrics = getContainerMemoryMetrics({
			limitPaths: [limitPath],
			usagePaths: [usagePath],
			configuredLimitMB: 0,
		});

		expect(metrics.limitMB).toBe(1000);
		expect(metrics.usageMB).toBe(750);
		expect(metrics.pressure).toBe(0.75);
	});

	test("prefers an explicit limit while retaining cgroup usage", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cap-container-memory-"));
		tempDirs.push(dir);
		const usagePath = join(dir, "memory.current");
		await writeFile(usagePath, String(1024 * 1024 * 900));

		const metrics = getContainerMemoryMetrics({
			limitPaths: [],
			usagePaths: [usagePath],
			configuredLimitMB: 1200,
		});

		expect(metrics.limitMB).toBe(1200);
		expect(metrics.usageMB).toBe(900);
		expect(metrics.pressure).toBe(0.75);
	});
});

test.each(["memory.current", "memory.usage_in_bytes"])(
	"excludes only clean inactive cache from %s pressure",
	async (filename) => {
		const dir = await mkdtemp(join(tmpdir(), "cap-container-cache-"));
		tempDirs.push(dir);
		const usagePath = join(dir, filename);
		await writeFile(usagePath, String(1000 * 1024 ** 2));
		const prefix = filename === "memory.current" ? "" : "total_";
		await writeFile(
			join(dir, "memory.stat"),
			[
				`${prefix}inactive_file ${800 * 1024 ** 2}`,
				`${prefix}${prefix ? "dirty" : "file_dirty"} ${50 * 1024 ** 2}`,
				`${prefix}${prefix ? "writeback" : "file_writeback"} ${25 * 1024 ** 2}`,
			].join("\n"),
		);
		expect(
			getContainerMemoryMetrics({
				usagePaths: [usagePath],
				configuredLimitMB: 1024,
			}),
		).toMatchObject({
			usageMB: 1000,
			workingSetMB: 275,
			reclaimableCacheMB: 725,
			pressure: 275 / 1024,
		});
	},
);

test.each([
	"",
	"inactive_file invalid",
	"inactive_file -1",
	"inactive_file 999999999999999999999",
	"inactive_file 100\nfile_dirty 0",
])(
	"retains conservative pressure when cache accounting is invalid (%s)",
	async (stats) => {
		const dir = await mkdtemp(join(tmpdir(), "cap-container-cache-"));
		tempDirs.push(dir);
		const usagePath = join(dir, "memory.current");
		await writeFile(usagePath, String(950 * 1024 ** 2));
		await writeFile(join(dir, "memory.stat"), stats);
		expect(
			getContainerMemoryMetrics({
				usagePaths: [usagePath],
				configuredLimitMB: 1000,
			}),
		).toMatchObject({
			workingSetMB: 950,
			reclaimableCacheMB: 0,
			pressure: 0.95,
		});
	},
);
