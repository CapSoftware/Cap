import assert from "node:assert/strict";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { condition } from "../../emails/audiences";
import {
	heldWorkflowAudience,
	workflowAudience,
} from "../../emails/delivery-safety";
import { journeys } from "../../emails/flows";
import registry from "../../emails/resources.json";
import type { Journey } from "../../emails/types";
import { LoopsApi, LoopsApiError } from "./api";

export const healthUrl = "https://cap.so/api/cron/sync-loops/health";

export function healthyReport(value: unknown, now = Date.now()) {
	if (!value || typeof value !== "object") return false;
	const report = value as Record<string, unknown>;
	const checkedAt =
		typeof report.checkedAt === "string" ? Date.parse(report.checkedAt) : NaN;
	return (
		report.healthy === true &&
		typeof report.totalJobs === "number" &&
		Number.isSafeInteger(report.totalJobs) &&
		report.totalJobs > 0 &&
		report.overdueJobs === 0 &&
		report.failingJobs === 0 &&
		Number.isFinite(checkedAt) &&
		checkedAt >= now - 60_000 &&
		checkedAt <= now + 5_000
	);
}

export async function checkSyncHealth(
	secret: string,
	request: (url: string, options: RequestInit) => Promise<Response> = fetch,
) {
	if (!secret) return false;
	try {
		const response = await request(healthUrl, {
			headers: { Authorization: `Bearer ${secret}` },
			cache: "no-store",
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		});
		return response.ok && healthyReport(await response.json());
	} catch {
		return false;
	}
}

export type SafetyTarget = {
	journey: Journey;
	workflowId: string;
	guardId: string;
	mailingListId: string;
};

export const safetyTargets: SafetyTarget[] = journeys.map((journey) => ({
	journey,
	workflowId:
		registry.resources[journey.key as keyof typeof registry.resources],
	guardId:
		registry.operations[
			`${journey.key}:guard` as keyof typeof registry.operations
		],
	mailingListId: registry.resources.mailingList,
}));

type Filter = {
	match: "all" | "any";
	conditions: { type: string; key?: string; operator?: string }[];
};
type Guard = {
	typeName: string;
	workflowRevisionId: string;
	audienceFilter: Filter | null;
	appliesDownstream: boolean;
};

export function filterIsHeld(filter: Filter | null) {
	return (
		filter?.match === "all" &&
		["isTrue", "isFalse"].every((operator) =>
			filter.conditions.some(
				(item) =>
					item.type === "property" &&
					item.key === "subscribed" &&
					item.operator === operator,
			),
		)
	);
}

export async function enforceDeliverySafety(
	api: Pick<LoopsApi, "request">,
	options: {
		healthy: boolean;
		apply: boolean;
		resume?: boolean;
		hold?: boolean;
		targets?: SafetyTarget[];
	},
) {
	if (options.hold && options.resume)
		throw new Error("Choose either --hold or --resume");
	if (options.resume && (!options.healthy || !options.apply))
		throw new Error("Resume requires healthy synchronization and --apply");
	const identity = await api.request<{ teamName: string }>("api-key");
	assert.equal(identity.teamName, registry.teamName);
	const results: { workflow: string; action: string }[] = [];
	for (const target of options.targets ?? safetyTargets) {
		try {
			const path = `workflows/${target.workflowId}`;
			const workflow = await api.request<{
				name: string;
				status: string;
				mailingListId: string;
				rootNodeId: string;
				nodes: Record<string, { nextNodeIds: string[] }>;
			}>(path);
			assert.equal(workflow.name, target.journey.name);
			assert(
				["Draft", "Sending", "Paused", "PausedAndQueueing"].includes(
					workflow.status,
				),
				"Unknown workflow status",
			);
			assert.equal(workflow.mailingListId, target.mailingListId);
			assert.deepEqual(workflow.nodes[workflow.rootNodeId]?.nextNodeIds, [
				target.guardId,
			]);
			const nodePath = `${path}/nodes/${target.guardId}`;
			const guard = await api.request<Guard>(nodePath);
			assert.equal(guard.typeName, "AudienceFilter");
			const active = workflowAudience(target.journey);
			const held = heldWorkflowAudience(target.journey);
			const alreadyHeld =
				filterIsHeld(guard.audienceFilter) && guard.appliesDownstream;
			const activeMatches =
				isDeepStrictEqual(guard.audienceFilter, active) &&
				guard.appliesDownstream;
			let nextFilter: Filter | undefined;
			let action: string;
			if (options.resume) {
				assert(
					activeMatches || isDeepStrictEqual(guard.audienceFilter, held),
					"Reconcile changed audience rules before resuming",
				);
				nextFilter = active;
				action = "resumed";
			} else if (alreadyHeld) {
				action = "already-held";
			} else if (options.healthy && !options.hold && activeMatches) {
				action = "healthy";
			} else {
				nextFilter = activeMatches
					? held
					: {
							match: "all",
							conditions: [
								...(guard.audienceFilter?.conditions ?? []),
								condition("subscribed", true),
								condition("subscribed", false),
							],
						};
				action = options.apply ? "held" : "would-hold";
			}
			if (
				nextFilter &&
				isDeepStrictEqual(nextFilter, guard.audienceFilter) &&
				guard.appliesDownstream
			)
				nextFilter = undefined;
			if (nextFilter && workflow.status === "Sending") {
				results.push({
					workflow: target.journey.key,
					action: "manual-pause-required",
				});
				continue;
			}
			if (nextFilter && options.apply) {
				await api.request(nodePath, "POST", {
					expectedRevisionId: guard.workflowRevisionId,
					payload: { audienceFilter: nextFilter, appliesDownstream: true },
				});
				const confirmed = await api.request<Guard>(nodePath);
				assert.deepEqual(confirmed.audienceFilter, nextFilter);
				assert.equal(confirmed.appliesDownstream, true);
			}
			results.push({ workflow: target.journey.key, action });
		} catch (error) {
			const sending =
				error instanceof LoopsApiError &&
				error.status === 400 &&
				typeof error.details === "object" &&
				error.details !== null &&
				"message" in error.details &&
				error.details.message ===
					"This operation is not allowed while the workflow is sending.";
			results.push({
				workflow: target.journey.key,
				action: sending ? "manual-pause-required" : "error",
			});
		}
	}
	return results;
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			apply: { type: "boolean", default: false },
			resume: { type: "boolean", default: false },
			hold: { type: "boolean", default: false },
		},
	});
	const healthy = values.hold
		? false
		: await checkSyncHealth(process.env.LOOPS_HEALTH_SECRET ?? "");
	const results = await enforceDeliverySafety(
		new LoopsApi(process.env.LOOPS_API_KEY ?? ""),
		{ healthy, apply: values.apply, resume: values.resume, hold: values.hold },
	);
	console.log(JSON.stringify({ healthy, results }));
	const manualPause = results.filter(
		(result) => result.action === "manual-pause-required",
	);
	if (manualPause.length)
		console.error(
			`Pause these workflows in Loops now: ${manualPause.map((result) => result.workflow).join(", ")}. The Loops API cannot edit audience filters while a workflow is sending. Delivery has not been stopped.`,
		);
	const successfulActions = values.hold
		? ["held", "already-held"]
		: ["healthy", "resumed"];
	if (
		(!healthy && !values.hold) ||
		results.some((result) => !successfulActions.includes(result.action))
	)
		process.exitCode = 1;
}
