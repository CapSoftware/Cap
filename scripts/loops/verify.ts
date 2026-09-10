import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { LoopsApi } from "./api";
import {
	audienceFilter,
	campaignTemplates,
	condition,
	journeys,
	programVersion,
} from "./program";

type Node = {
	typeName: string;
	nextNodeIds: string[];
	emailMessageId?: string;
	amount?: number;
	unit?: string;
	contactPropertyQuery?: unknown;
	reEligible?: boolean;
	audienceFilter?: unknown;
	appliesDownstream?: boolean;
};
type Workflow = {
	status: string;
	name: string;
	mailingListId: string;
	rootNodeId: string;
	nodes: Record<string, Node>;
};
type Email = {
	subject: string;
	previewText: string;
	fromEmail: string;
	replyToEmail: string;
	lmx: string;
	contactPropertiesFallbacks: Record<string, string>;
};

const { values } = parseArgs({
	options: {
		state: { type: "string" },
		team: { type: "string" },
		"mailing-list": { type: "string" },
	},
});
assert(values.state && values.team && values["mailing-list"]);
const receipt: {
	version: string;
	teamName: string;
	resources: Record<string, string>;
	operations: Record<string, string>;
} = JSON.parse(await readFile(values.state, "utf8"));
assert.equal(receipt.version, programVersion);
assert.equal(receipt.teamName, values.team);
const api = new LoopsApi(process.env.LOOPS_API_KEY ?? "");
const identity = await api.request<{ teamName: string }>("api-key");
assert.equal(identity.teamName, values.team);
const text = (lmx: string) =>
	lmx
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
const links = (lmx: string) =>
	[...lmx.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
let emails = 0;
const verifyEmail = async (
	id: string | undefined,
	expected: { subject: string; previewText: string; body: string },
) => {
	assert(id);
	const email = await api.request<Email>(`email-messages/${id}`);
	assert.equal(email.subject, expected.subject);
	assert.equal(email.previewText, expected.previewText);
	assert.equal(email.fromEmail, "richie");
	assert.equal(email.replyToEmail, "richie@cap.so");
	assert.equal(email.contactPropertiesFallbacks.firstName, "there");
	assert(
		text(email.lmx).includes(text(expected.body)),
		`Email body changed: ${id}`,
	);
	for (const link of links(expected.body))
		assert(links(email.lmx).includes(link));
	const guardian = await api.request<{
		errors: unknown[];
		warnings: unknown[];
	}>(`email-messages/${id}/guardian`);
	assert.deepEqual(guardian.errors, []);
	assert.deepEqual(guardian.warnings, []);
	emails++;
};

for (const journey of journeys) {
	const id = receipt.resources[journey.key];
	const workflow = await api.request<Workflow>(`workflows/${id}`);
	assert.equal(workflow.status, "Draft");
	assert.equal(workflow.name, journey.name);
	assert.equal(workflow.mailingListId, values["mailing-list"]);
	const visited = new Set<string>();
	const node = (nodeId: string, type: string) => {
		assert(!visited.has(nodeId), `Duplicate managed node: ${nodeId}`);
		visited.add(nodeId);
		const result = workflow.nodes[nodeId];
		assert.equal(result?.typeName, type);
		return result;
	};
	const trigger = node(workflow.rootNodeId, "ContactPropertyTrigger");
	assert.equal(trigger.reEligible, false);
	assert.deepEqual(trigger.contactPropertyQuery, {
		key: "capLifecycleStage",
		is: { value: journey.key, operator: "equal" },
		was: { value: journey.key, operator: "not_equal" },
	});
	let previous = [workflow.rootNodeId];
	const connect = (next: string) => {
		for (const prior of previous)
			assert.deepEqual(workflow.nodes[prior].nextNodeIds, [next]);
		previous = [next];
	};
	const guardId = receipt.operations[`${journey.key}:guard`];
	connect(guardId);
	node(guardId, "AudienceFilter");
	const guard = await api.request<Node>(`workflows/${id}/nodes/${guardId}`);
	const filter = audienceFilter(journey.audience, journey.promotional);
	filter.conditions.push(
		condition("capLifecycleEnabled", true),
		condition("capOnboardingEligible", true),
	);
	assert.deepEqual(guard.audienceFilter, filter);
	assert.equal(guard.appliesDownstream, true);
	for (const message of journey.messages) {
		const operation = `${journey.key}:${message.key}`;
		if (message.delayDays) {
			const timerId = receipt.operations[`${operation}:timer`];
			connect(timerId);
			const timer = node(timerId, "TimerAction");
			assert.equal(timer.amount, message.delayDays);
			assert.equal(timer.unit, "d");
		}
		let skipped: string | undefined;
		if (message.onlyIf) {
			const branchId = receipt.operations[`${operation}:branch`];
			connect(branchId);
			const branch = node(branchId, "BranchNode");
			assert.equal(branch.nextNodeIds.length, 2);
			for (let index = 0; index < 2; index++) {
				const childId = branch.nextNodeIds[index];
				node(childId, "AudienceFilter");
				const child = await api.request<Node>(
					`workflows/${id}/nodes/${childId}`,
				);
				assert.deepEqual(child.audienceFilter, {
					match: "all",
					conditions: [
						condition(
							message.onlyIf.property,
							index === 0 ? message.onlyIf.value : !message.onlyIf.value,
						),
					],
				});
				assert.equal(child.appliesDownstream, false);
			}
			previous = [branch.nextNodeIds[0]];
			skipped = branch.nextNodeIds[1];
		}
		const emailId = receipt.operations[`${operation}:email`];
		connect(emailId);
		const email = node(emailId, "SendEmailAction");
		await verifyEmail(email.emailMessageId, message);
		if (skipped) previous.push(skipped);
	}
	const exits = Object.entries(workflow.nodes).filter(
		([, value]) => value.typeName === "ExitAction",
	);
	assert.equal(exits.length, 1);
	connect(exits[0][0]);
	assert.deepEqual(node(exits[0][0], "ExitAction").nextNodeIds, []);
	assert.equal(visited.size, Object.keys(workflow.nodes).length);
	console.log(
		JSON.stringify({
			workflow: journey.name,
			status: "Draft",
			graphVerified: true,
		}),
	);
}

for (const template of campaignTemplates) {
	const campaign = await api.request<{
		status: string;
		mailingListId: string;
		audienceSegmentId: string;
		emailMessageId: string;
	}>(`campaigns/${receipt.resources[template.key]}`);
	assert.equal(campaign.status, "Draft");
	assert.equal(campaign.mailingListId, values["mailing-list"]);
	assert.equal(
		campaign.audienceSegmentId,
		receipt.resources[`segment:${template.key}`],
	);
	const segment = await api.request<{ filter: unknown }>(
		`audience-segments/${campaign.audienceSegmentId}`,
	);
	assert.deepEqual(
		segment.filter,
		audienceFilter(template.audience, template.promotional),
	);
	await verifyEmail(campaign.emailMessageId, template);
}
console.log(
	JSON.stringify({
		workflows: journeys.length,
		campaigns: campaignTemplates.length,
		emails,
		guardianErrors: 0,
		guardianWarnings: 0,
		allDraft: true,
	}),
);
