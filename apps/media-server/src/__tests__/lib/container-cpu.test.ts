import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getContainerCpuLimit,
	getContainerCpuUsageMicros,
} from "../../lib/container-cpu";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("container CPU metrics", () => {
	test("reads a cgroup v2 CPU quota", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cap-container-cpu-"));
		tempDirs.push(dir);
		const cpuMaxPath = join(dir, "cpu.max");
		await writeFile(cpuMaxPath, "200000 100000");

		expect(
			getContainerCpuLimit({
				cpuMaxPath,
				cpuQuotaPath: join(dir, "missing-quota"),
				cpuPeriodPath: join(dir, "missing-period"),
			}),
		).toBe(2);
	});

	test("reads cgroup v2 aggregate CPU usage", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cap-container-cpu-"));
		tempDirs.push(dir);
		const cpuStatPath = join(dir, "cpu.stat");
		await writeFile(
			cpuStatPath,
			"usage_usec 1234567\nuser_usec 1000000\nsystem_usec 234567\n",
		);

		expect(
			getContainerCpuUsageMicros({
				cpuStatPath,
				cpuUsagePath: join(dir, "missing-usage"),
			}),
		).toBe(1234567);
	});
});
