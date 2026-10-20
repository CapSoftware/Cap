import { existsSync, readFileSync } from "node:fs";

const CGROUP_V2_CPU_MAX_PATH = "/sys/fs/cgroup/cpu.max";
const CGROUP_V1_CPU_QUOTA_PATH = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us";
const CGROUP_V1_CPU_PERIOD_PATH = "/sys/fs/cgroup/cpu/cpu.cfs_period_us";
const CGROUP_V2_CPU_STAT_PATH = "/sys/fs/cgroup/cpu.stat";
const CGROUP_V1_CPU_USAGE_PATH = "/sys/fs/cgroup/cpuacct/cpuacct.usage";

function readValue(path: string): string | null {
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf8").trim() || null;
	} catch {
		return null;
	}
}

export interface ContainerCpuOptions {
	cpuMaxPath?: string;
	cpuQuotaPath?: string;
	cpuPeriodPath?: string;
	cpuStatPath?: string;
	cpuUsagePath?: string;
}

export function getContainerCpuLimit(
	options: ContainerCpuOptions = {},
): number {
	const cpuMax = readValue(options.cpuMaxPath ?? CGROUP_V2_CPU_MAX_PATH);
	if (cpuMax) {
		const [quotaValue, periodValue] = cpuMax.split(/\s+/);
		if (quotaValue !== "max") {
			const quota = Number.parseInt(quotaValue ?? "0", 10);
			const period = Number.parseInt(periodValue ?? "0", 10);
			if (quota > 0 && period > 0) return quota / period;
		}
	}

	const quota = Number.parseInt(
		readValue(options.cpuQuotaPath ?? CGROUP_V1_CPU_QUOTA_PATH) ?? "0",
		10,
	);
	const period = Number.parseInt(
		readValue(options.cpuPeriodPath ?? CGROUP_V1_CPU_PERIOD_PATH) ?? "0",
		10,
	);
	return quota > 0 && period > 0 ? quota / period : 0;
}

export function getContainerCpuUsageMicros(
	options: ContainerCpuOptions = {},
): number {
	const cpuStat = readValue(options.cpuStatPath ?? CGROUP_V2_CPU_STAT_PATH);
	if (cpuStat) {
		for (const line of cpuStat.split(/\r?\n/)) {
			const [name, value] = line.trim().split(/\s+/);
			if (name !== "usage_usec") continue;
			const usage = Number.parseInt(value ?? "0", 10);
			if (usage >= 0) return usage;
		}
	}

	const usageNanos = Number.parseInt(
		readValue(options.cpuUsagePath ?? CGROUP_V1_CPU_USAGE_PATH) ?? "0",
		10,
	);
	return usageNanos > 0 ? usageNanos / 1000 : 0;
}
