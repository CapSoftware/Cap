import { describe, expect, test } from "bun:test";
import {
	heldWorkflowAudience,
	workflowAudience,
} from "../../emails/delivery-safety";
import { type LoopsApi, LoopsApiError } from "./api";
import {
	checkSyncHealth,
	enforceDeliverySafety,
	filterIsHeld,
	healthyReport,
	safetyTargets,
} from "./watchdog";

function fakeProvider(status = "Draft") {
	const guards = new Map(
		safetyTargets.map((target) => [
			target.workflowId,
			{
				typeName: "AudienceFilter",
				workflowRevisionId: "revision-1",
				audienceFilter: workflowAudience(target.journey),
				appliesDownstream: true,
			},
		]),
	);
	const writes: string[] = [];
	const attemptedWrites: string[] = [];
	let brokenWorkflow: string | undefined;
	let startedWorkflow: string | undefined;
	let startedOnWrite = false;
	let startError: Error | undefined;
	const api: Pick<LoopsApi, "request"> = {
		async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
			if (path === "api-key") return { teamName: "Cap Software, Inc." } as T;
			const target = safetyTargets.find((item) =>
				path.includes(item.workflowId),
			);
			if (!target) throw new Error("Unknown workflow");
			if (path.includes("/nodes/")) {
				const guard = guards.get(target.workflowId);
				if (!guard) throw new Error("Unknown guard");
				if (method === "POST") {
					attemptedWrites.push(target.workflowId);
					if (target.workflowId === startedWorkflow) {
						startedOnWrite = true;
						if (startError) throw startError;
					}
					if (status === "Sending" || target.workflowId === startedWorkflow)
						throw new LoopsApiError(400, path, {
							message:
								"This operation is not allowed while the workflow is sending.",
						});
					if (target.workflowId === brokenWorkflow)
						throw new Error("Unavailable");
					const update = body as {
						expectedRevisionId: string;
						payload: Pick<typeof guard, "audienceFilter" | "appliesDownstream">;
					};
					expect(update.expectedRevisionId).toBe(guard.workflowRevisionId);
					Object.assign(guard, update.payload, {
						workflowRevisionId: "revision-2",
					});
					writes.push(target.workflowId);
				}
				return structuredClone(guard) as T;
			}
			return {
				name: target.journey.name,
				status:
					target.workflowId === startedWorkflow && startedOnWrite
						? "Sending"
						: status,
				mailingListId: target.mailingListId,
				rootNodeId: "trigger",
				nodes: { trigger: { nextNodeIds: [target.guardId] } },
			} as T;
		},
	};
	return {
		api,
		guards,
		writes,
		attemptedWrites,
		startDuringWrite: (id: string, error?: Error) => {
			startedWorkflow = id;
			startError = error;
		},
		fail: (id: string) => {
			brokenWorkflow = id;
		},
	};
}

describe("independent delivery safety", () => {
	test("a manual hold blocks healthy journeys and rejects conflicting resume", async () => {
		const provider = fakeProvider();
		await expect(
			enforceDeliverySafety(provider.api, {
				healthy: true,
				apply: true,
				hold: true,
				resume: true,
			}),
		).rejects.toThrow("Choose either");
		expect(provider.writes).toHaveLength(0);
		const results = await enforceDeliverySafety(provider.api, {
			healthy: true,
			apply: true,
			hold: true,
		});
		expect(results.every((result) => result.action === "held")).toBe(true);
	});

	test("concurrent activation is detected even when the provider error format changes", async () => {
		for (const error of [
			new LoopsApiError(400, "nodes/guard", { error: "Workflow is active" }),
			new SyntaxError("Unexpected response encoding"),
		]) {
			const provider = fakeProvider();
			provider.startDuringWrite(safetyTargets[0].workflowId, error);
			const result = await enforceDeliverySafety(provider.api, {
				healthy: false,
				apply: true,
			});
			expect(result[0].action).toBe("manual-pause-required");
			expect(provider.attemptedWrites).toHaveLength(safetyTargets.length);
		}
	});

	test("healthy operation never rewrites audiences", async () => {
		const provider = fakeProvider();
		const result = await enforceDeliverySafety(provider.api, {
			healthy: true,
			apply: true,
		});
		expect(result.every((item) => item.action === "healthy")).toBe(true);
		expect(provider.writes).toHaveLength(0);
	});

	test("an outage holds stopped journeys and recovery never resumes them automatically", async () => {
		const provider = fakeProvider();
		const result = await enforceDeliverySafety(provider.api, {
			healthy: false,
			apply: true,
		});
		expect(result.every((item) => item.action === "held")).toBe(true);
		for (const target of safetyTargets) {
			const guard = provider.guards.get(target.workflowId);
			expect(guard?.audienceFilter).toEqual(
				heldWorkflowAudience(target.journey),
			);
			expect(guard?.appliesDownstream).toBe(true);
		}
		const recovered = await enforceDeliverySafety(provider.api, {
			healthy: true,
			apply: true,
		});
		expect(recovered.every((item) => item.action === "already-held")).toBe(
			true,
		);
		expect(provider.writes).toHaveLength(safetyTargets.length);
	});

	test("an unhealthy running journey requires manual pause without attempting forbidden edits", async () => {
		const provider = fakeProvider("Sending");
		const result = await enforceDeliverySafety(provider.api, {
			healthy: false,
			apply: true,
		});
		expect(
			result.every((item) => item.action === "manual-pause-required"),
		).toBe(true);
		expect(provider.attemptedWrites).toHaveLength(0);
		for (const guard of provider.guards.values())
			expect(filterIsHeld(guard.audienceFilter)).toBe(false);
	});

	test("explicit holds on running journeys require manual pause even during a dry run", async () => {
		for (const apply of [true, false]) {
			const provider = fakeProvider("Sending");
			const result = await enforceDeliverySafety(provider.api, {
				healthy: true,
				hold: true,
				apply,
			});
			expect(
				result.every((item) => item.action === "manual-pause-required"),
			).toBe(true);
			expect(provider.attemptedWrites).toHaveLength(0);
		}
	});

	test("a journey starting between read and write still reports the manual pause requirement", async () => {
		const provider = fakeProvider();
		provider.startDuringWrite(safetyTargets[0].workflowId);
		const result = await enforceDeliverySafety(provider.api, {
			healthy: false,
			apply: true,
		});
		expect(result[0].action).toBe("manual-pause-required");
		expect(result.slice(1).every((item) => item.action === "held")).toBe(true);
	});

	test("unknown workflow states fail without edits", async () => {
		const provider = fakeProvider("Unknown");
		const result = await enforceDeliverySafety(provider.api, {
			healthy: false,
			apply: true,
		});
		expect(result.every((item) => item.action === "error")).toBe(true);
		expect(provider.attemptedWrites).toHaveLength(0);
	});

	test("healthy running journeys are not rewritten when already resumed", async () => {
		const provider = fakeProvider("Sending");
		const result = await enforceDeliverySafety(provider.api, {
			healthy: true,
			apply: true,
			resume: true,
		});
		expect(result.every((item) => item.action === "resumed")).toBe(true);
		expect(provider.attemptedWrites).toHaveLength(0);
	});

	test("removing a hold requires pausing a running workflow first", async () => {
		const provider = fakeProvider("Sending");
		for (const target of safetyTargets) {
			const guard = provider.guards.get(target.workflowId);
			if (!guard) throw new Error("Missing fixture");
			guard.audienceFilter = heldWorkflowAudience(target.journey);
		}
		const result = await enforceDeliverySafety(provider.api, {
			healthy: true,
			apply: true,
			resume: true,
		});
		expect(
			result.every((item) => item.action === "manual-pause-required"),
		).toBe(true);
		expect(provider.attemptedWrites).toHaveLength(0);
	});

	test("resuming requires explicit apply and a fresh healthy result", async () => {
		const provider = fakeProvider();
		await expect(
			enforceDeliverySafety(provider.api, {
				healthy: false,
				apply: true,
				resume: true,
			}),
		).rejects.toThrow("Resume requires");
		await expect(
			enforceDeliverySafety(provider.api, {
				healthy: true,
				apply: false,
				resume: true,
			}),
		).rejects.toThrow("Resume requires");
		await enforceDeliverySafety(provider.api, { healthy: false, apply: true });
		const result = await enforceDeliverySafety(provider.api, {
			healthy: true,
			apply: true,
			resume: true,
		});
		expect(result.every((item) => item.action === "resumed")).toBe(true);
		for (const target of safetyTargets)
			expect(provider.guards.get(target.workflowId)?.audienceFilter).toEqual(
				workflowAudience(target.journey),
			);
	});

	test("a failed guard update does not prevent holding the other journeys", async () => {
		const provider = fakeProvider();
		provider.fail(safetyTargets[0].workflowId);
		const result = await enforceDeliverySafety(provider.api, {
			healthy: false,
			apply: true,
		});
		expect(result.filter((item) => item.action === "error")).toHaveLength(1);
		expect(result.filter((item) => item.action === "held")).toHaveLength(
			safetyTargets.length - 1,
		);
	});

	test("audience drift closes delivery and cannot be silently overwritten on resume", async () => {
		const provider = fakeProvider();
		const guard = provider.guards.get(safetyTargets[0].workflowId);
		if (!guard) throw new Error("Missing fixture");
		guard.audienceFilter.conditions.push({
			type: "property",
			key: "capHasVideo",
			operator: "isTrue",
		});
		await enforceDeliverySafety(provider.api, { healthy: true, apply: true });
		expect(filterIsHeld(guard.audienceFilter)).toBe(true);
		const resumed = await enforceDeliverySafety(provider.api, {
			healthy: true,
			apply: true,
			resume: true,
		});
		expect(resumed[0].action).toBe("error");
		expect(filterIsHeld(guard.audienceFilter)).toBe(true);
	});

	test("a dry run reports the hold without changing Loops", async () => {
		const provider = fakeProvider();
		const result = await enforceDeliverySafety(provider.api, {
			healthy: false,
			apply: false,
		});
		expect(result.every((item) => item.action === "would-hold")).toBe(true);
		expect(provider.writes).toHaveLength(0);
	});
});

describe("health response boundaries", () => {
	const now = Date.parse("2026-09-11T15:00:00Z");
	const report = {
		healthy: true,
		checkedAt: new Date(now).toISOString(),
		totalJobs: 1,
		overdueJobs: 0,
		failingJobs: 0,
	};

	test("requires a recent nonempty queue without backlog or repeated failures", () => {
		expect(healthyReport(report, now)).toBe(true);
		for (const invalid of [
			null,
			{},
			{ ...report, checkedAt: "invalid" },
			{ ...report, checkedAt: new Date(now - 60_001).toISOString() },
			{ ...report, checkedAt: new Date(now + 5_001).toISOString() },
			{ ...report, totalJobs: 0 },
			{ ...report, overdueJobs: 1 },
			{ ...report, failingJobs: 1 },
		])
			expect(healthyReport(invalid, now)).toBe(false);
	});

	test("HTTP errors, malformed JSON and network failures fail the health check", async () => {
		expect(
			await checkSyncHealth(
				"secret",
				async () => new Response("error", { status: 500 }),
			),
		).toBe(false);
		expect(
			await checkSyncHealth("secret", async () => new Response("not JSON")),
		).toBe(false);
		expect(
			await checkSyncHealth("secret", async () => {
				throw new Error("offline");
			}),
		).toBe(false);
	});

	test("health reads never follow redirects with the secret", async () => {
		expect(
			await checkSyncHealth("secret", async (url, options) => {
				expect(url).toBe("https://cap.so/api/cron/sync-loops/health");
				expect(options.redirect).toBe("error");
				expect(options.cache).toBe("no-store");
				return Response.json({
					...report,
					checkedAt: new Date().toISOString(),
				});
			}),
		).toBe(true);
	});
});
