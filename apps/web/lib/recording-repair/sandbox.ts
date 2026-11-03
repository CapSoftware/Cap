import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { serverEnv } from "@cap/env";
import { Sandbox } from "@vercel/sandbox";

export type RepairOperation = "recover" | "open";

export class RepairBusyError extends Error {}

const BRIDGE_PORT = 8787;
const SANDBOX_TIMEOUT_MS = 30 * 60_000;
const AGENT_DEADLINE_MS = 25 * 60_000;
const DEFAULT_COST_LIMIT_USD = 5;
const SESSION_PREFIX = "cap-repair-";
const DEFAULT_SESSIONS_PER_DAY = 6;
const WORK = "/vercel/sandbox/work";
const RUNTIME = "/opt/cap-repair";
const STAGE = "/vercel/sandbox/stage";
const REPO = "https://github.com/CapSoftware/Cap.git";
const SPARSE_PATHS = ["crates", "apps/desktop-gpui/src", "apps/cli/src"];

export type BrokeredModel = {
	model: string;
	provider: Record<string, unknown>;
	allow: Record<string, { transform: { headers: Record<string, string> }[] }[]>;
};

type RepairModelId = "claude-opus-5-5" | "gpt-6.1-terra";

const REPAIR_MODELS: Record<
	RepairModelId,
	{
		name: string;
		gateway: string;
		direct: {
			provider: "anthropic" | "openai";
			id: string;
			host: string;
			header: (key: string) => Record<string, string>;
			key: (env: ReturnType<typeof serverEnv>) => string | undefined;
		};
		limit: { context: number; output: number };
		cost: {
			input: number;
			output: number;
			cache_read: number;
			cache_write: number;
		};
	}
> = {
	"claude-opus-5-5": {
		name: "Claude Opus 5.5",
		gateway: "anthropic/claude-opus-5.5",
		direct: {
			provider: "anthropic",
			id: "claude-opus-5-5",
			host: "api.anthropic.com",
			header: (key) => ({ "x-api-key": key }),
			key: (env) => env.ANTHROPIC_API_KEY,
		},
		limit: { context: 200_000, output: 32_000 },
		cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
	},
	"gpt-6.1-terra": {
		name: "GPT-6.1 Terra",
		gateway: "openai/gpt-6.1-terra",
		direct: {
			provider: "openai",
			id: "gpt-6.1-terra",
			host: "api.openai.com",
			header: (key) => ({ authorization: `Bearer ${key}` }),
			key: (env) => env.OPENAI_API_KEY,
		},
		limit: { context: 400_000, output: 32_000 },
		cost: { input: 1, output: 5, cache_read: 0.05, cache_write: 1 },
	},
};

const BROKERED_KEY = "brokered-by-sandbox-firewall";

export function resolveRepairModel(): BrokeredModel | null {
	const env = serverEnv();
	const spec = REPAIR_MODELS[env.RECORDING_REPAIR_MODEL ?? "claude-opus-5-5"];
	const model = { name: spec.name, limit: spec.limit, cost: spec.cost };
	if (env.AI_GATEWAY_API_KEY) {
		return {
			model: `vercel/${spec.gateway}`,
			provider: {
				vercel: {
					options: { apiKey: BROKERED_KEY },
					models: { [spec.gateway]: model },
				},
			},
			allow: {
				"ai-gateway.vercel.sh": [
					{
						transform: [
							{
								headers: { authorization: `Bearer ${env.AI_GATEWAY_API_KEY}` },
							},
						],
					},
				],
			},
		};
	}
	const key = spec.direct.key(env);
	if (!key) return null;
	return {
		model: `${spec.direct.provider}/${spec.direct.id}`,
		provider: {
			[spec.direct.provider]: {
				options: { apiKey: BROKERED_KEY },
				models: { [spec.direct.id]: model },
			},
		},
		allow: {
			[spec.direct.host]: [
				{ transform: [{ headers: spec.direct.header(key) }] },
			],
		},
	};
}

export function repairSettings() {
	const env = serverEnv();
	const enabled = env.RECORDING_REPAIR_ENABLED === true;
	return {
		enabled: enabled && resolveRepairModel() !== null,
		submissions: enabled && env.RECORDING_REPAIR_SUBMISSIONS_ENABLED !== false,
		costLimitUsd: env.RECORDING_REPAIR_COST_LIMIT_USD ?? DEFAULT_COST_LIMIT_USD,
		sessionsPerDay:
			env.RECORDING_REPAIR_DAILY_LIMIT ?? DEFAULT_SESSIONS_PER_DAY,
	};
}

export function repairTagForVersion(appVersion: string) {
	return /^\d+\.\d+\.\d+$/.test(appVersion) ? `cap-v${appVersion}` : null;
}

export function isRepairSessionId(value: string) {
	return /^cap-repair-[a-f0-9]{24}$/.test(value);
}

const sandboxFile = (name: string) =>
	readFile(
		path.join(process.cwd(), "lib", "recording-repair", "sandbox", name),
	);

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function run(
	sandbox: Sandbox,
	script: string,
	options: { sudo?: boolean; timeoutMs?: number } = {},
) {
	const result = await sandbox.runCommand({
		cmd: "bash",
		args: ["-euo", "pipefail", "-c", script],
		sudo: options.sudo ?? false,
		timeoutMs: options.timeoutMs ?? 120_000,
	});
	if (result.exitCode !== 0) {
		const stderr = (await result.stderr()).slice(-600);
		throw new Error(
			`sandbox setup step failed (${result.exitCode}): ${stderr}`,
		);
	}
	return (await result.stdout()).trim();
}

async function assertCapacity(userId: string) {
	const { sessionsPerDay } = repairSettings();
	const { sandboxes } = await Sandbox.list({
		tags: { repairUser: userId },
		limit: Math.min(50, Math.max(20, sessionsPerDay + 1)),
		sortBy: "createdAt",
		sortOrder: "desc",
	});
	const active = sandboxes.filter((sandbox) =>
		["pending", "running"].includes(sandbox.status),
	);
	if (active.length > 0)
		throw new RepairBusyError("A repair is already running");
	const dayAgo = Date.now() - 24 * 60 * 60_000;
	if (
		sandboxes.filter((sandbox) => sandbox.createdAt > dayAgo).length >=
		sessionsPerDay
	)
		throw new RepairBusyError("Daily repair limit reached");
}

export async function createRepairSession(args: {
	userId: string;
	operation: RepairOperation;
	appVersion: string;
	model: BrokeredModel;
}) {
	const { model } = args;
	await assertCapacity(args.userId);

	const sessionId = `${SESSION_PREFIX}${randomBytes(12).toString("hex")}`;
	const bridgeToken = randomBytes(32).toString("hex");
	const [runner, mcp, playbook] = await Promise.all([
		sandboxFile("runner.mjs"),
		sandboxFile("mcp.mjs"),
		sandboxFile("AGENTS.md"),
	]);

	const sandbox = await Sandbox.create({
		name: sessionId,
		ports: [BRIDGE_PORT],
		timeout: SANDBOX_TIMEOUT_MS,
		persistent: false,
		resources: { vcpus: 2 },
		networkPolicy: "allow-all",
		tags: {
			feature: "recording-repair",
			repairUser: args.userId,
			operation: args.operation,
		},
	});

	try {
		const tag = repairTagForVersion(args.appVersion);
		const clone = (ref: string | null) =>
			`git clone --quiet --depth 1 ${ref ? `--branch ${shellQuote(ref)} ` : ""}--filter=blob:none --sparse ${REPO} /vercel/sandbox/cap && git -C /vercel/sandbox/cap sparse-checkout set ${SPARSE_PATHS.join(" ")}`;

		await Promise.all([
			run(
				sandbox,
				`${clone(tag)} || { rm -rf /vercel/sandbox/cap; ${clone(null)}; }`,
				{ timeoutMs: 180_000 },
			),
			run(
				sandbox,
				"apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null",
				{ sudo: true, timeoutMs: 180_000 },
			),
			sandbox.writeFiles([
				{ path: `${STAGE}/runner.mjs`, content: runner },
				{ path: `${STAGE}/mcp.mjs`, content: mcp },
				{ path: `${STAGE}/AGENTS.md`, content: playbook },
			]),
		]);

		const ids = await run(
			sandbox,
			[
				"id -u agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash agent",
				`install -d -o root -g root -m 755 ${RUNTIME} ${WORK}`,
				`install -o root -g root -m 644 ${STAGE}/runner.mjs ${STAGE}/mcp.mjs ${RUNTIME}/`,
				`install -o root -g root -m 644 ${STAGE}/AGENTS.md ${WORK}/AGENTS.md`,
				`rm -rf ${STAGE}`,
				`mv /vercel/sandbox/cap ${WORK}/cap`,
				`chown -R root:root ${WORK}/cap && chmod -R a+rX,go-w ${WORK}/cap`,
				`install -d -o agent -g agent -m 755 ${WORK}/recording ${WORK}/out ${WORK}/scratch`,
				"echo $(id -u agent) $(id -g agent)",
			].join(" && "),
			{ sudo: true },
		);
		const [uid, gid] = ids.split(" ");

		await sandbox.update({ networkPolicy: { allow: model.allow } });

		await sandbox.runCommand({
			cmd: "node",
			args: [`${RUNTIME}/runner.mjs`],
			sudo: true,
			detached: true,
			env: {
				BRIDGE_PORT: String(BRIDGE_PORT),
				BRIDGE_TOKEN: bridgeToken,
				REPAIR_MODEL: model.model,
				REPAIR_OPENCODE_CONFIG: JSON.stringify({
					autoupdate: false,
					share: "disabled",
					provider: model.provider,
					permission: {
						webfetch: "deny",
						websearch: "deny",
						task: "deny",
						question: "deny",
						skill: "deny",
						external_directory: "deny",
					},
				}),
				AGENT_UID: uid ?? "",
				AGENT_GID: gid ?? "",
				AGENT_HOME: "/home/agent",
				REPAIR_WORK: WORK,
				REPAIR_DEADLINE_MS: String(AGENT_DEADLINE_MS),
				REPAIR_COST_LIMIT_USD: String(repairSettings().costLimitUsd),
			},
		});

		await run(
			sandbox,
			`for i in $(seq 1 50); do code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:${BRIDGE_PORT}/v1/poll || true); [ "$code" = "401" ] && exit 0; sleep 0.2; done; exit 1`,
		);

		return {
			sessionId,
			bridgeUrl: sandbox.domain(BRIDGE_PORT),
			bridgeToken,
			expiresAt: new Date(Date.now() + SANDBOX_TIMEOUT_MS).toISOString(),
		};
	} catch (error) {
		await sandbox.stop().catch(() => {});
		throw error;
	}
}

export async function stopRepairSession(args: {
	userId: string;
	sessionId: string;
}) {
	if (!isRepairSessionId(args.sessionId)) return false;
	const sandbox = await Sandbox.get({ name: args.sessionId }).catch(() => null);
	if (!sandbox || sandbox.tags?.repairUser !== args.userId) return false;
	await sandbox.stop().catch(() => {});
	return true;
}
