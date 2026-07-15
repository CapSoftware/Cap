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
