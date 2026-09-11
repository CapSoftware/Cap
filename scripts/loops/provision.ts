import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { emailContent } from "../../emails/brand";
import { normalizeLmx } from "../emails/content";
import { LoopsApi, LoopsApiError } from "./api";
import {
	audienceFilter,
	campaignTemplates,
	components,
	condition,
	contactProperties,
	journeys,
	programVersion,
	theme,
} from "./program";

type Named = { id: string; name: string };
type Node = {
	id: string;
	typeName: string;
	nextNodeIds: string[];
	emailMessageId?: string;
};
type Workflow = Named & {
	status: string;
	description: string;
	mailingListId: string | null;
	workflowRevisionId: string | null;
	rootNodeId: string;
	nodes: Record<string, Node>;
};
type Email = {
	contentRevisionId: string | null;
	subject: string;
	lmx: string;
};
type Receipt = {
	teamName: string;
	version: string;
	resources: Record<string, string>;
	operations: Record<string, string>;
	definitions: Record<string, string>;
	guardian: Record<string, { errors: unknown[]; warnings: unknown[] }>;
};

const { values } = parseArgs({
	options: {
		apply: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
		state: { type: "string" },
		team: { type: "string" },
		"mailing-list": { type: "string" },
	},
});

if (values.apply && values["dry-run"])
	throw new Error("Choose --apply or --dry-run");
if (!values.team)
	throw new Error("Pass --team with the expected Loops team name");
if (values.apply && !values.state)
	throw new Error("--apply requires a private --state file");

const api = new LoopsApi(process.env.LOOPS_API_KEY ?? "");
const identity = await api.request<{ success: boolean; teamName: string }>(
	"api-key",
);
if (!identity.success || identity.teamName !== values.team)
	throw new Error("Wrong Loops team");

let receipt: Receipt = {
	teamName: identity.teamName,
	version: programVersion,
	resources: {},
	operations: {},
	definitions: {},
	guardian: {},
};
if (values.state) {
	try {
		receipt = JSON.parse(await readFile(values.state, "utf8"));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
	}
}
if (
	receipt.teamName !== identity.teamName ||
	receipt.version !== programVersion
) {
	throw new Error("State file belongs to a different team or program");
}

const save = async () => {
	if (values.apply && values.state) {
		await writeFile(values.state, `${JSON.stringify(receipt, null, 2)}\n`, {
			mode: 0o600,
		});
	}
};
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const named = (rows: Named[], name: string) => {
	const matches = rows.filter((row) => row.name === name);
	if (matches.length > 1) throw new Error(`Duplicate managed name: ${name}`);
	return matches[0];
};

try {
	const existingProperties = await api.request<{ key: string; type: string }[]>(
		"contacts/properties",
	);
	const lists = await api.request<Named[]>("lists");
	const workflows = await api.list<Workflow>("workflows");
	const themes = await api.list<Named>("themes");
	const sharedComponents = await api.list<Named>("components");
	const segments = await api.list<Named>("audience-segments");
	const campaigns = await api.list<
		Named & { status: string; emailMessageId: string }
	>("campaigns");
	const listId =
		values["mailing-list"] ?? named(lists, "Product updates and tips")?.id;
	if (listId && !lists.some((list) => list.id === listId))
		throw new Error("Unknown mailing list");
	console.log(
		JSON.stringify({
			team: identity.teamName,
			mode: values.apply ? "apply drafts" : "dry run",
			workflows: journeys.length,
			emails: journeys.reduce(
				(count, journey) => count + journey.messages.length,
				0,
			),
			campaignTemplates: campaignTemplates.length,
			mailingListId:
				listId ?? "Create Product updates and tips in the Loops dashboard",
		}),
	);
	if (!values.apply) process.exit(0);
	if (!listId)
		console.log(
			"Mailing list is pending dashboard setup; resources remain drafts.",
		);
	if (listId) receipt.resources.mailingList = listId;
	await save();

	for (const [name, type] of Object.entries(contactProperties)) {
		const existing = existingProperties.find(
			(property) => property.key === name,
		);
		if (existing && existing.type !== type)
			throw new Error(`Wrong property type: ${name}`);
		if (!existing)
			await api.request("contacts/properties", "POST", { name, type });
	}

	const ensure = async (
		path: string,
		rows: Named[],
		definition: { name: string },
		key: string,
	) => {
		const existing = named(rows, definition.name);
		if (existing && path === "themes") {
			const current = await api.request<{ styles: Record<string, unknown> }>(
				`${path}/${existing.id}`,
			);
			for (const [style, value] of Object.entries(theme.styles))
				assert.deepEqual(
					current.styles[style],
					value,
					"Shared theme changed; create a new branding version before updating drafts",
				);
		}
		if (existing && path === "components") {
			const current = await api.request<{ lmx: string }>(
				`${path}/${existing.id}`,
			);
			const expected = components.find(
				(component) => component.name === definition.name,
			);
			assert(expected);
			assert.equal(
				normalizeLmx(current.lmx),
				normalizeLmx(expected.lmx),
				"Shared component changed; create a new branding version before updating drafts",
			);
		}
		const resource =
			existing ?? (await api.request<Named>(path, "POST", definition));
		receipt.resources[key] = resource.id;
		await save();
		return resource.id;
	};
	const themeId = await ensure("themes", themes, theme, "theme");
	const componentIds: string[] = [];
	for (const component of components) {
		componentIds.push(
			await ensure("components", sharedComponents, component, component.name),
		);
	}
	const editEmail = async (
		id: string,
		message: { subject: string; previewText: string; body: string },
	) => {
		const definition = emailContent(message, {
			theme: themeId,
			header: componentIds[0],
			signature: componentIds[1],
		});
		const current = await api.request<Email>(`email-messages/${id}`);
		if (
			receipt.definitions[id] !== hash(definition) ||
			current.subject !== definition.subject
		) {
			const result = await api.request<{ warnings?: unknown[] }>(
				`email-messages/${id}`,
				"POST",
				{
					expectedRevisionId: current.contentRevisionId,
					...definition,
				},
			);
			if (result.warnings?.length)
				console.log(
					JSON.stringify({ email: id, compileWarnings: result.warnings }),
				);
			receipt.definitions[id] = hash(definition);
			await save();
		}
		const guardian = await api.request<{
			errors: unknown[];
			warnings: unknown[];
		}>(`email-messages/${id}/guardian`);
		receipt.guardian[id] = guardian;
		await save();
		if (guardian.errors.length)
			throw new Error(
				`Guardian errors for ${id}: ${JSON.stringify(guardian.errors)}`,
			);
	};

	for (const journey of journeys) {
		const existing = named(workflows, journey.name);
		let workflow = existing
			? await api.request<Workflow>(`workflows/${existing.id}`)
			: await api.request<Workflow>("workflows", "POST", {
					name: journey.name,
					description: `${programVersion}; managed by scripts/loops/provision.ts. Draft only. ${journey.messages.map((m) => m.delayDays).join(", ")} day relative delays. Imports never enroll.`,
					mailingListId: listId,
				});
		if (workflow.status !== "Draft")
			throw new Error(`Refusing to edit non-draft workflow ${journey.name}`);
		if (!workflow.description.includes(programVersion))
			throw new Error("Existing workflow is not owned by this program");
		if (listId && workflow.mailingListId !== listId) {
			const changed = await api.request<{
				status: string;
				workflow?: Workflow;
			}>(`workflows/${workflow.id}/mailing-list`, "POST", {
				expectedRevisionId: workflow.workflowRevisionId,
				mailingListId: listId,
			});
			if (!changed.workflow)
				throw new Error(
					"Mailing-list assignment needs review; no queued contacts were discarded",
				);
			workflow = changed.workflow;
		}
		receipt.resources[journey.key] = workflow.id;
		await save();
		const exitIds = Object.entries(workflow.nodes)
			.filter(([, n]) => n.typeName === "ExitAction")
			.map(([id]) => id);
		if (exitIds.length !== 1)
			throw new Error(`Expected one shared exit in ${journey.name}`);
		const exitId = exitIds[0];
		const update = async (id: string, payload: unknown, operation: string) => {
			const digest = hash(payload);
			if (receipt.definitions[operation] === digest) return;
			const result = await api.request<{ workflow: Workflow }>(
				`workflows/${workflow.id}/nodes/${id}`,
				"POST",
				{
					expectedRevisionId: workflow.workflowRevisionId,
					payload,
				},
			);
			workflow = result.workflow;
			receipt.definitions[operation] = digest;
			await save();
		};
		const insert = async (
			type: string,
			operation: string,
			fromNodeId?: string,
		) => {
			const recordedId = receipt.operations[operation];
			if (recordedId) {
				const node = workflow.nodes[recordedId];
				if (!node || node.typeName !== type)
					throw new Error(`Managed node changed: ${operation}`);
				return { ...node, id: recordedId };
			}
			const result = await api.request<{ node: Node; workflow: Workflow }>(
				`workflows/${workflow.id}/nodes`,
				"POST",
				{
					expectedRevisionId: workflow.workflowRevisionId,
					nodeTypeName: type,
					...(fromNodeId
						? { insertMode: "between", fromNodeId, toNodeId: exitId }
						: { insertMode: "before", beforeNodeId: exitId }),
				},
			);
			workflow = result.workflow;
			receipt.operations[operation] = result.node.id;
			await save();
			return result.node;
		};
		await update(
			workflow.rootNodeId,
			{
				typeName: "ContactPropertyTrigger",
				contactPropertyQuery: {
					key: "capLifecycleStage",
					is: { operator: "equal", value: journey.key },
					was: { operator: "not_equal", value: journey.key },
				},
				reEligible: false,
			},
			`${journey.key}:trigger`,
		);
		const guard = await insert("AudienceFilter", `${journey.key}:guard`);
		const filter = audienceFilter(journey.audience, journey.promotional);
		filter.conditions.push(
			condition("capLifecycleEnabled", true),
			condition("capOnboardingEligible", true),
		);
		await update(
			guard.id,
			{ audienceFilter: filter, appliesDownstream: true },
			`${journey.key}:guard-config`,
		);
		for (const message of journey.messages) {
			const operation = `${journey.key}:${message.key}`;
			if (message.delayDays) {
				const timer = await insert("TimerAction", `${operation}:timer`);
				await update(
					timer.id,
					{ amount: message.delayDays, unit: "d" },
					`${operation}:timer-config`,
				);
			}
			let fromNodeId: string | undefined;
			if (message.onlyIf) {
				const branch = await insert("BranchNode", `${operation}:branch`);
				const children = workflow.nodes[branch.id].nextNodeIds;
				if (children.length !== 2)
					throw new Error("Expected two milestone branches");
				for (let index = 0; index < 2; index++) {
					await update(
						children[index],
						{
							audienceFilter: {
								match: "all",
								conditions: [
									condition(
										message.onlyIf.property,
										index === 0 ? message.onlyIf.value : !message.onlyIf.value,
									),
								],
							},
							appliesDownstream: false,
						},
						`${operation}:branch-${index}`,
					);
				}
				fromNodeId = children[0];
			}
			const email = await insert(
				"SendEmailAction",
				`${operation}:email`,
				fromNodeId,
			);
			if (!email.emailMessageId) throw new Error("Missing email message ID");
			await editEmail(email.emailMessageId, message);
		}
		const verified = await api.request<Workflow>(`workflows/${workflow.id}`);
		if (verified.status !== "Draft")
			throw new Error("Workflow status changed unexpectedly");
		console.log(
			JSON.stringify({
				name: journey.name,
				id: verified.id,
				status: verified.status,
				nodes: Object.keys(verified.nodes).length,
			}),
		);
	}

	for (const template of campaignTemplates) {
		const segmentName = `${template.name} audience`;
		const segmentId = await ensure(
			"audience-segments",
			segments,
			{
				name: segmentName,
				description:
					"Managed by Cap lifecycle v1. Verify current consent and entitlements before scheduling.",
				filter: audienceFilter(template.audience, template.promotional),
			} as { name: string },
			`segment:${template.key}`,
		);
		const existing = named(campaigns, template.name);
		const campaign = existing
			? await api.request<{
					id: string;
					status: string;
					emailMessageId: string;
				}>(`campaigns/${existing.id}`)
			: await api.request<{
					id: string;
					status: string;
					emailMessageId: string;
				}>("campaigns", "POST", {
					name: template.name,
					mailingListId: listId,
					audienceSegmentId: segmentId,
				});
		const current = await api.request<{ status: string }>(
			`campaigns/${campaign.id}`,
		);
		if (current.status !== "Draft")
			throw new Error("Refusing to edit a non-draft campaign");
		if (listId)
			await api.request(`campaigns/${campaign.id}`, "POST", {
				mailingListId: listId,
				audienceSegmentId: segmentId,
			});
		receipt.resources[template.key] = campaign.id;
		await save();
		await editEmail(campaign.emailMessageId, template);
		console.log(
			JSON.stringify({ name: template.name, id: campaign.id, status: "Draft" }),
		);
	}
	await save();
	console.log(
		"Verified draft resources. No publish, activation, event, or send request was made.",
	);
} catch (error) {
	if (error instanceof LoopsApiError)
		console.error(
			JSON.stringify({
				status: error.status,
				path: error.path,
				details: error.details,
			}),
		);
	else
		console.error(
			error instanceof Error ? error.message : "Provisioning failed",
		);
	process.exitCode = 1;
}
