import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
	value: {} as Record<string, unknown>,
}));
const sandboxMock = vi.hoisted(() => ({
	create: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
}));

vi.mock("@cap/env", () => ({ serverEnv: () => envMock.value }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: sandboxMock }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: vi.fn() }));
vi.mock("@cap/database/emails/recording-repair-request", () => ({
	RecordingRepairRequest: vi.fn(() => null),
}));

import { sendEmail } from "@cap/database/emails/config";
import {
	type BrokeredModel,
	createRepairSession,
	isRepairSessionId,
	RepairBusyError,
	repairSettings,
	repairTagForVersion,
	resolveRepairModel,
	stopRepairSession,
} from "@/lib/recording-repair/sandbox";
import {
	completeSubmission,
	isSubmissionId,
	MAX_SUBMISSION_BYTES,
	partLength,
	partSizeFor,
} from "@/lib/recording-repair/submissions";
import { runPromise } from "@/lib/server";

const model: BrokeredModel = {
	model: "anthropic/claude-opus-5-5",
	provider: {},
	allow: {
		"api.anthropic.com": [
			{ transform: [{ headers: { "x-api-key": "secret-key" } }] },
		],
	},
};

function fakeSandbox() {
	const calls: string[] = [];
	const sandbox = {
		tags: { repairUser: "user-1" },
		runCommand: vi.fn(async (params: Record<string, unknown>) => {
			calls.push(params.detached ? "start-runner" : "command");
			return {
				exitCode: 0,
				stdout: async () => (params.sudo ? "1001 1001" : ""),
				stderr: async () => "",
			};
		}),
		writeFiles: vi.fn(async () => {}),
		update: vi.fn(async () => {
			calls.push("lockdown");
		}),
		domain: vi.fn(() => "https://sb-test.vercel.run"),
		stop: vi.fn(async () => ({})),
	};
	return { sandbox, calls };
}

describe("recording repair model selection", () => {
	it("prefers the AI Gateway and brokers its key at the firewall", () => {
		envMock.value = { AI_GATEWAY_API_KEY: "gw", ANTHROPIC_API_KEY: "an" };
		const resolved = resolveRepairModel();
		expect(resolved?.model).toBe("vercel/anthropic/claude-opus-5.5");
		expect(resolved?.allow).toEqual({
			"ai-gateway.vercel.sh": [
				{ transform: [{ headers: { authorization: "Bearer gw" } }] },
			],
		});
		expect(JSON.stringify(resolved?.provider)).not.toContain("gw");
	});

	it("falls back to Anthropic and is unavailable without any key", () => {
		envMock.value = { ANTHROPIC_API_KEY: "an" };
		expect(resolveRepairModel()?.model).toBe("anthropic/claude-opus-5-5");
		expect(JSON.stringify(resolveRepairModel()?.provider)).not.toContain(
			'"an"',
		);
		envMock.value = {};
		expect(resolveRepairModel()).toBeNull();
	});

	it("switches to GPT-6.1 Terra and prices every model for the cost cap", () => {
		envMock.value = {
			RECORDING_REPAIR_MODEL: "gpt-6.1-terra",
			OPENAI_API_KEY: "oa",
		};
		const direct = resolveRepairModel();
		expect(direct?.model).toBe("openai/gpt-6.1-terra");
		expect(direct?.allow).toEqual({
			"api.openai.com": [
				{ transform: [{ headers: { authorization: "Bearer oa" } }] },
			],
		});
		expect(JSON.stringify(direct?.provider)).not.toContain('"oa"');
		expect(JSON.stringify(direct?.provider)).toContain('"cost"');

		envMock.value = {
			RECORDING_REPAIR_MODEL: "gpt-6.1-terra",
			AI_GATEWAY_API_KEY: "gw",
		};
		expect(resolveRepairModel()?.model).toBe("vercel/openai/gpt-6.1-terra");

		envMock.value = {
			RECORDING_REPAIR_MODEL: "gpt-6.1-terra",
			ANTHROPIC_API_KEY: "an",
		};
		expect(resolveRepairModel()).toBeNull();
	});
});

describe("recording repair settings", () => {
	it("stays off until the server enables it with a model key", () => {
		envMock.value = { ANTHROPIC_API_KEY: "an" };
		expect(repairSettings()).toMatchObject({
			enabled: false,
			submissions: false,
		});
		envMock.value = {
			RECORDING_REPAIR_ENABLED: true,
			RECORDING_REPAIR_SUBMISSIONS_ENABLED: true,
		} as never;
		expect(repairSettings().enabled).toBe(false);
		expect(repairSettings().submissions).toBe(true);
		envMock.value = {
			RECORDING_REPAIR_ENABLED: true,
			RECORDING_REPAIR_SUBMISSIONS_ENABLED: false,
			ANTHROPIC_API_KEY: "an",
			RECORDING_REPAIR_COST_LIMIT_USD: 2,
			RECORDING_REPAIR_DAILY_LIMIT: 3,
		} as never;
		expect(repairSettings()).toEqual({
			enabled: true,
			submissions: false,
			costLimitUsd: 2,
			sessionsPerDay: 3,
		});
	});
});

describe("recording repair identifiers", () => {
	it("maps release versions to tags and refuses anything else", () => {
		expect(repairTagForVersion("0.6.2")).toBe("cap-v0.6.2");
		expect(repairTagForVersion("0.6.2-nightly.1")).toBeNull();
		expect(repairTagForVersion("0.6.2; rm -rf /")).toBeNull();
	});

	it("only accepts generated ids", () => {
		expect(isRepairSessionId("cap-repair-0123456789abcdef01234567")).toBe(true);
		expect(isRepairSessionId("cap-repair-../other")).toBe(false);
		expect(isSubmissionId("sub_0123456789abcdef01234567")).toBe(true);
		expect(isSubmissionId("sub_x/../../other-user")).toBe(false);
	});

	it("keeps multipart uploads within S3 part limits", () => {
		expect(partSizeFor(1)).toBe(16 * 1024 * 1024);
		const size = partSizeFor(MAX_SUBMISSION_BYTES);
		expect(Math.ceil(MAX_SUBMISSION_BYTES / size)).toBeLessThanOrEqual(10_000);
		expect(size % (1024 * 1024)).toBe(0);
	});

	it("only signs parts inside the declared archive, at their exact length", () => {
		const part = partSizeFor(40 * 1024 * 1024);
		expect(partLength(40 * 1024 * 1024, 1)).toBe(part);
		expect(partLength(40 * 1024 * 1024, 3)).toBe(40 * 1024 * 1024 - 2 * part);
		expect(partLength(40 * 1024 * 1024, 4)).toBeNull();
		expect(partLength(40 * 1024 * 1024, 0)).toBeNull();
		expect(partLength(1, 1)).toBe(1);
		expect(partLength(1, 2)).toBeNull();
	});
});

describe("completeSubmission", () => {
	it("fails when the team's email is not sent", async () => {
		vi.mocked(runPromise)
			.mockResolvedValueOnce({
				sizeBytes: 10,
				operation: "open",
				appVersion: "0.6.2",
				os: "macos",
				errorMessage: "x",
				diagnosis: null,
				sessionId: null,
			})
			.mockResolvedValueOnce(undefined);
		vi.mocked(sendEmail).mockResolvedValueOnce({
			data: null,
			error: { name: "email_not_configured", message: "not configured" },
		} as never);
		await expect(
			completeSubmission({
				userId: "user-1",
				userEmail: "a@b.c",
				submissionId: "sub_000000000000000000000000",
				uploadId: "u",
				parts: [{ partNumber: 1, etag: "e" }],
			}),
		).rejects.toThrow("email failed");
	});
});

describe("createRepairSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sandboxMock.list.mockResolvedValue({ sandboxes: [] });
	});

	it("locks the network down before starting the agent and never hands it the key", async () => {
		const { sandbox, calls } = fakeSandbox();
		sandboxMock.create.mockResolvedValue(sandbox);

		const session = await createRepairSession({
			userId: "user-1",
			operation: "recover",
			appVersion: "0.6.2",
			model,
		});

		const created = sandboxMock.create.mock.calls[0]?.[0];
		expect(created.persistent).toBe(false);
		expect(created.ports).toEqual([8787]);
		expect(created.tags.repairUser).toBe("user-1");
		expect(sandbox.update).toHaveBeenCalledWith({
			networkPolicy: { allow: model.allow },
		});
		expect(calls.indexOf("lockdown")).toBeLessThan(
			calls.indexOf("start-runner"),
		);

		const runner = sandbox.runCommand.mock.calls.find(
			([params]) => (params as { detached?: boolean }).detached,
		)?.[0] as { env: Record<string, string>; sudo: boolean };
		expect(runner.sudo).toBe(true);
		expect(JSON.stringify(runner.env)).not.toContain("secret-key");
		expect(runner.env.BRIDGE_TOKEN).toBe(session.bridgeToken);
		expect(session.bridgeToken).toMatch(/^[a-f0-9]{64}$/);
		expect(isRepairSessionId(session.sessionId)).toBe(true);
		expect(session.bridgeUrl).toBe("https://sb-test.vercel.run");
	});

	it("stops the sandbox when setup fails", async () => {
		const { sandbox } = fakeSandbox();
		sandbox.update.mockRejectedValueOnce(new Error("policy failed"));
		sandboxMock.create.mockResolvedValue(sandbox);
		await expect(
			createRepairSession({
				userId: "user-1",
				operation: "open",
				appVersion: "0.6.2",
				model,
			}),
		).rejects.toThrow("policy failed");
		expect(sandbox.stop).toHaveBeenCalled();
	});

	it("refuses a second concurrent session and the daily limit", async () => {
		sandboxMock.list.mockResolvedValueOnce({
			sandboxes: [{ status: "running", createdAt: Date.now() }],
		});
		await expect(
			createRepairSession({
				userId: "user-1",
				operation: "recover",
				appVersion: "0.6.2",
				model,
			}),
		).rejects.toBeInstanceOf(RepairBusyError);

		sandboxMock.list.mockResolvedValueOnce({
			sandboxes: Array.from({ length: 6 }, () => ({
				status: "stopped",
				createdAt: Date.now() - 1000,
			})),
		});
		await expect(
			createRepairSession({
				userId: "user-1",
				operation: "recover",
				appVersion: "0.6.2",
				model,
			}),
		).rejects.toBeInstanceOf(RepairBusyError);
		expect(sandboxMock.create).not.toHaveBeenCalled();
	});
});

describe("stopRepairSession", () => {
	it("only stops the caller's own sandbox", async () => {
		const { sandbox } = fakeSandbox();
		sandboxMock.get.mockResolvedValue(sandbox);
		expect(
			await stopRepairSession({
				userId: "someone-else",
				sessionId: "cap-repair-0123456789abcdef01234567",
			}),
		).toBe(false);
		expect(sandbox.stop).not.toHaveBeenCalled();
		expect(
			await stopRepairSession({
				userId: "user-1",
				sessionId: "cap-repair-0123456789abcdef01234567",
			}),
		).toBe(true);
		expect(sandbox.stop).toHaveBeenCalled();
		expect(sandbox.runCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				cmd: "cat",
				args: ["/opt/cap-repair/session-log.jsonl"],
			}),
		);
		expect(runPromise).toHaveBeenCalled();
		expect(
			await stopRepairSession({ userId: "user-1", sessionId: "../x" }),
		).toBe(false);
	});
});
