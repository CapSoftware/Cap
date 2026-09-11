import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { components, deliveryFormat, theme } from "../../emails/brand";
import {
	heldWorkflowAudience,
	workflowAudience,
} from "../../emails/delivery-safety";
import registry from "../../emails/resources.json";
import { assertEmailContent, normalizeLmx } from "../emails/content";
import { LoopsApi, LoopsApiError } from "./api";
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
type Email = Record<string, unknown> & {
	subject: string;
	previewText: string;
	fromEmail: string;
	replyToEmail: string;
	lmx: string;
	contactPropertiesFallbacks: Record<string, string>;
};

const { values } = parseArgs({
	options: {
		state: {
			type: "string",
			default: fileURLToPath(
				new URL("../../emails/resources.json", import.meta.url),
			),
		},
		team: { type: "string", default: registry.teamName },
		"mailing-list": { type: "string", default: registry.resources.mailingList },
		"structure-only": { type: "boolean", default: false },
		"require-held": { type: "boolean", default: false },
		"allow-live": { type: "boolean", default: false },
		journey: { type: "string" },
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
const brandIds = {
	theme: receipt.resources.theme,
	header: receipt.resources[components[0].name],
	signature: receipt.resources[components[1].name],
};
assert(
	brandIds.theme && brandIds.header && brandIds.signature,
	"Brand IDs missing from resources.json",
);
if (deliveryFormat === "lmx") {
	const remoteTheme = await api.request<{
		name: string;
		styles: Record<string, unknown>;
	}>(`themes/${brandIds.theme}`);
	assert.equal(remoteTheme.name, theme.name);
	for (const [key, value] of Object.entries(theme.styles))
		assert.deepEqual(
			remoteTheme.styles[key],
			value,
			`Shared theme differs: ${key}`,
		);
	for (const component of components) {
		const remote = await api.request<{ name: string; lmx: string }>(
			`components/${receipt.resources[component.name]}`,
		);
		assert.equal(remote.name, component.name);
		assert.equal(
			normalizeLmx(remote.lmx),
			normalizeLmx(component.lmx),
			`Shared component differs: ${component.name}`,
		);
	}
}
let emails = 0;
let customEmails = 0;
let heldWorkflows = 0;
const verifyEmail = async (
	id: string | undefined,
	expected: { subject: string; previewText: string; body: string },
) => {
	assert(id);
	let email: Email;
	try {
		email = await api.request<Email>(`email-messages/${id}`);
	} catch (error) {
		if (
			error instanceof LoopsApiError &&
			error.status === 409 &&
			typeof error.details === "object" &&
			error.details !== null &&
			"message" in error.details &&
			error.details.message === "MJML format is not supported via API."
		) {
			assert.equal(deliveryFormat, "mjml");
			customEmails++;
			return;
		}
		throw error;
	}
	assert.notEqual(
		deliveryFormat,
		"mjml",
		"Managed email is still in native format",
	);
	assertEmailContent(email, expected, brandIds);
	const guardian = await api.request<{
		errors: unknown[];
		warnings: unknown[];
	}>(`email-messages/${id}/guardian`);
	assert.deepEqual(guardian.errors, []);
	assert.deepEqual(guardian.warnings, []);
	emails++;
};

const selectedJourneys = values.journey
	? journeys.filter((journey) => journey.key === values.journey)
	: journeys;
assert(selectedJourneys.length, "Unknown journey");
const selectedCampaigns = values.journey ? [] : campaignTemplates;
for (const journey of selectedJourneys) {
	const id = receipt.resources[journey.key];
	const workflow = await api.request<Workflow>(`workflows/${id}`);
	assert(
		(values["allow-live"]
			? ["Draft", "Sending", "Paused", "PausedAndQueueing"]
			: ["Draft"]
		).includes(workflow.status),
		`Unexpected workflow status: ${workflow.status}`,
	);
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
	const held = isDeepStrictEqual(
		guard.audienceFilter,
		heldWorkflowAudience(journey),
	);
	if (held) heldWorkflows++;
	else assert.deepEqual(guard.audienceFilter, workflowAudience(journey));
	if (values["require-held"])
		assert(held, "Workflow delivery guard is not held");
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
			status: workflow.status,
			graphVerified: true,
			deliveryHeld: held,
		}),
	);
}

for (const template of selectedCampaigns) {
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
		workflows: selectedJourneys.length,
		campaigns: selectedCampaigns.length,
		apiEmailContentVerified: emails,
		customEmailContentRequiresBrowserReview: customEmails,
		guardianVerifiedEmails: emails,
		deliveryHeldWorkflows: heldWorkflows,
		liveStatesAllowed: values["allow-live"],
	}),
);
if (customEmails && !values["structure-only"])
	throw new Error(
		"Workflow structure and draft states passed. Custom MJML content is unavailable through the API; verify its rendered body, metadata, logo, footer and fallbacks in the browser. Use --structure-only to request only the API checks.",
	);
