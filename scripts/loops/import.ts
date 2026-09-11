import { appendFile, chmod, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { LoopsApi, LoopsApiError } from "./api";
import { type ContactProfile, emailHash } from "./profile";
import { importContactUpdate, type RemoteContact } from "./sync-policy";

type Receipt = {
	hash: string;
	status: "created" | "existing" | "updated" | "invalid";
	id?: string;
	detail?: unknown;
};
const { values } = parseArgs({
	options: {
		contacts: { type: "string" },
		receipt: { type: "string" },
		team: { type: "string" },
		apply: { type: "boolean", default: false },
		limit: { type: "string" },
		"mailing-list": { type: "string" },
		"retry-invalid": { type: "boolean", default: false },
	},
});
if (!values.contacts || !values.receipt || !values.team)
	throw new Error("Pass --contacts, --receipt and --team");
const filename = values.receipt;
const profiles: ContactProfile[] = JSON.parse(
	await readFile(values.contacts, "utf8"),
);
const hashes = new Set<string>();
for (const profile of profiles) {
	const hash = emailHash(profile.email);
	if (
		hashes.has(hash) ||
		!profile.subscribed ||
		profile.capConsent !== "subscribed" ||
		profile.capLifecycleEnabled ||
		profile.capOnboardingEligible ||
		profile.capLifecycleStage !== "idle"
	)
		throw new Error(
			"Import must contain unique, positively subscribed, held contacts",
		);
	hashes.add(hash);
}
const prior: Receipt[] = [];
try {
	for (const line of (await readFile(filename, "utf8"))
		.split("\n")
		.filter(Boolean))
		prior.push(JSON.parse(line));
} catch (error) {
	if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
		throw error;
}
const latest = new Map(prior.map((row) => [row.hash, row]));
const done = new Set(
	[...latest.values()]
		.filter(
			(row) =>
				row.status !== "existing" &&
				!(values["retry-invalid"] && row.status === "invalid"),
		)
		.map((row) => row.hash),
);
const limit = values.limit ? Number(values.limit) : profiles.length;
if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid limit");
const pending = profiles
	.filter((profile) => !done.has(emailHash(profile.email)))
	.slice(0, limit);
const api = new LoopsApi(process.env.LOOPS_API_KEY ?? "", 150);
const identity = await api.request<{ success: boolean; teamName: string }>(
	"api-key",
);
if (!identity.success || identity.teamName !== values.team)
	throw new Error("Wrong Loops team");
const workflows = await api.list<{ id: string }>("workflows");
for (const row of workflows) {
	const workflow = await api.request<{ status: string }>(`workflows/${row.id}`);
	if (workflow.status !== "Draft")
		throw new Error("Contact import requires all workflows to remain drafts");
}
const lists = await api.request<{ id: string; name: string }[]>("lists");
const listId =
	values["mailing-list"] ??
	lists.find((list) => list.name === "Product updates and tips")?.id;
if (listId && !lists.some((list) => list.id === listId))
	throw new Error("Unknown mailing list");
console.log(
	JSON.stringify({
		team: identity.teamName,
		mode: values.apply ? "create missing contacts" : "dry run",
		total: profiles.length,
		alreadyProcessed: done.size,
		pending: pending.length,
		mailingListId: listId ?? null,
	}),
);
if (!values.apply) process.exit(0);
await appendFile(filename, "", { mode: 0o600 });
await chmod(filename, 0o600);
let next = 0;
let stopped = false;
let completed = 0;
const counts = { created: 0, existing: 0, updated: 0, invalid: 0 };
const worker = async () => {
	while (!stopped && next < pending.length) {
		const profile = pending[next++];
		if (!profile) return;
		const hash = emailHash(profile.email);
		let receipt: Receipt;
		try {
			const result = await api.request<{ success: boolean; id: string }>(
				"contacts/create",
				"POST",
				{ ...profile, ...(listId ? { mailingLists: { [listId]: true } } : {}) },
			);
			if (!result.success || !result.id)
				throw new Error(
					"Unexpected create response; reconcile before retrying",
				);
			receipt = { hash, status: "created", id: result.id };
		} catch (error) {
			if (error instanceof LoopsApiError && error.status === 409) {
				const contacts = await api.request<RemoteContact[]>(
					`contacts/find?email=${encodeURIComponent(profile.email)}`,
				);
				const contact = contacts[0];
				if (contacts.length !== 1 || !contact) {
					stopped = true;
					throw new Error(
						"Resolve the existing contact identity before resuming",
					);
				}
				await api.request(
					"contacts/update",
					"PUT",
					importContactUpdate(profile, contact, listId),
				);
				receipt = { hash, status: "updated", id: contact.id };
			} else if (error instanceof LoopsApiError && error.status === 400)
				receipt = { hash, status: "invalid", detail: error.details };
			else {
				stopped = true;
				throw error;
			}
		}
		await appendFile(filename, `${JSON.stringify(receipt)}\n`);
		counts[receipt.status]++;
		completed++;
		if (completed % 250 === 0)
			console.log(
				JSON.stringify({ processed: done.size + completed, ...counts }),
			);
	}
};
const results = await Promise.allSettled(
	Array.from({ length: 8 }, async () => {
		try {
			await worker();
		} catch (error) {
			stopped = true;
			throw error;
		}
	}),
);
console.log(
	JSON.stringify({
		processed: done.size + completed,
		...counts,
		remaining: profiles.length - done.size - completed,
	}),
);
for (const result of results)
	if (result.status === "rejected") {
		console.error(
			result.reason instanceof LoopsApiError
				? `Import stopped with HTTP ${result.reason.status}; resume with the same receipt`
				: "Import stopped; reconcile the receipt before resuming",
		);
		process.exitCode = 1;
	}
