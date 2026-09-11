import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applicationEmails } from "../../emails/application";
import { audienceFilter, contactProperties } from "../../emails/audiences";
import {
	components,
	contactFallbacks,
	sender,
	theme,
} from "../../emails/brand";
import { campaignTemplates } from "../../emails/campaigns";
import { customerCopy } from "../../emails/customer-copy";
import { journeys } from "../../emails/flows";
import resources from "../../emails/resources.json";
import type { EmailDefinition, Journey } from "../../emails/types";

export const root = new URL("../../", import.meta.url);
export const marketingEmails = [
	...journeys.flatMap((journey) => journey.messages),
	...campaignTemplates,
];

export const validateEmail = (email: EmailDefinition) => {
	const errors: string[] = [];
	if (!/^[a-z][a-z0-9-]+$/.test(email.id)) errors.push("Invalid email ID");
	for (const field of ["purpose", "subject", "previewText", "body"] as const) {
		if (!email[field].trim()) errors.push(`Missing ${field}`);
	}
	if (/<(?:Style|Component)\b/.test(email.body))
		errors.push(
			"Use shared branding; do not embed Style or Component in email bodies",
		);
	if (
		/\b(?:bgColor|textColor|fontSize|fontFamily|borderRadius)\s*=/.test(
			email.body,
		)
	)
		errors.push("Put visual branding in emails/brand.ts");
	const content = `${email.subject}\n${email.previewText}\n${email.body}`;
	const variables = [...content.matchAll(/\{([^{}]+)\}/g)].map(
		(match) => match[1],
	);
	const declared = new Set<string>(email.variables);
	for (const variable of variables) {
		const key = variable.replace(/^contact\./, "");
		if (!variable.startsWith("contact.") || !declared.has(key))
			errors.push(`Undeclared contact variable: ${variable}`);
		if (!Object.hasOwn(contactFallbacks, key))
			errors.push(`Missing fallback: ${key}`);
	}
	for (const key of declared) {
		if (!variables.includes(`contact.${key}`))
			errors.push(`Unused declared variable: ${key}`);
	}
	if (new TextEncoder().encode(email.body).length > 95_000)
		errors.push(
			"Email body leaves insufficient space for branding under the 100 KB LMX limit",
		);
	for (const match of email.body.matchAll(/<(?:Button|Link)\b([^>]*)>/g)) {
		const href = /\bhref="([^"]+)"/.exec(match[1])?.[1];
		if (!href || !/^(https:\/\/|mailto:)/.test(href))
			errors.push("Buttons and links need an https or mailto destination");
	}
	return errors;
};

export const flowSteps = (journey: Journey) => {
	let day = 0;
	return journey.messages.map((message) => {
		day += message.delayDays;
		return { ...message, day };
	});
};
const workflowFilter = (journey: Journey) => ({
	...audienceFilter(journey.audience, journey.promotional),
	conditions: [
		...audienceFilter(journey.audience, journey.promotional).conditions,
		{ type: "property", key: "capLifecycleEnabled", operator: "isTrue" },
		{ type: "property", key: "capOnboardingEligible", operator: "isTrue" },
	],
});

export const validateCatalog = async () => {
	const errors = marketingEmails.flatMap((email) =>
		validateEmail(email).map((error) => `${email.id}: ${error}`),
	);
	const allIds = [...marketingEmails, ...applicationEmails].map(
		(email) => email.id,
	);
	if (new Set(allIds).size !== allIds.length)
		errors.push("Duplicate email IDs");
	for (const journey of journeys) {
		if (!journey.messages.length) errors.push(`Empty journey: ${journey.key}`);
		const keys = journey.messages.map((message) => message.key);
		if (new Set(keys).size !== keys.length)
			errors.push(`Duplicate steps: ${journey.key}`);
		if (journey.audience === "teammate" && journey.promotional)
			errors.push("Teammates cannot receive promotional journeys");
		for (const message of journey.messages) {
			if (!Number.isInteger(message.delayDays) || message.delayDays < 0)
				errors.push(`Invalid delay: ${message.id}`);
			if (
				message.onlyIf &&
				contactProperties[
					message.onlyIf.property as keyof typeof contactProperties
				] !== "boolean"
			)
				errors.push(`Unknown boolean milestone: ${message.onlyIf.property}`);
		}
	}
	const files = (await readdir(new URL("emails/marketing/", root))).filter(
		(file) => file.endsWith(".ts"),
	);
	const expected = marketingEmails.map((email) => `${email.id}.ts`);
	for (const file of new Set([...files, ...expected])) {
		if (!files.includes(file) || !expected.includes(file))
			errors.push(`Unregistered or missing email: ${file}`);
	}
	const templateFiles = (
		await readdir(new URL("packages/database/emails/", root))
	).filter((file) => file.endsWith(".tsx"));
	const registeredTemplates = applicationEmails.map(
		(email) => `${email.template}.tsx`,
	);
	for (const file of new Set([...templateFiles, ...registeredTemplates])) {
		if (!templateFiles.includes(file) || !registeredTemplates.includes(file))
			errors.push(`Unregistered or missing application template: ${file}`);
	}
	const sources = new Set(applicationEmails.flatMap((email) => email.sources));
	for (const source of sources) {
		try {
			await readFile(new URL(source, root), "utf8");
		} catch {
			errors.push(`Missing application source: ${source}`);
		}
	}
	for (const folder of [
		"apps/web/actions",
		"apps/web/app",
		"apps/web/lib",
		"packages/database/auth",
	]) {
		for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(
			fileURLToPath(new URL(`${folder}/`, root)),
		)) {
			const source = `${folder}/${file}`;
			const text = await readFile(new URL(source, root), "utf8");
			if (/\bsendEmail\s*\(/.test(text) && !sources.has(source))
				errors.push(`Unregistered application send source: ${source}`);
		}
	}
	return errors;
};

const cell = (text: string) =>
	text.replaceAll("|", "\\|").replaceAll("\n", " ");
const sourceLink = (source: string, label = source) =>
	`[${label}](../${source.replaceAll("[", "%5B").replaceAll("]", "%5D")})`;
const sourceFor = (email: EmailDefinition) => `emails/marketing/${email.id}.ts`;
const resourceIds: Record<string, string> = resources.resources;
const flowUrl = (key: string) =>
	`https://app.loops.so/workflows/${resourceIds[key]}`;

export const renderCatalog = () => {
	const lines = [
		"# Cap email catalogue",
		"",
		"Generated from the email library with `bun run emails:catalog`. Edit the source files, then regenerate. [Editing guide](README.md).",
		"",
		"## Lifecycle flows",
		"",
		"These are the locally configured draft journeys. This document is not a live status check. Imports remain held; production enrollment is not deployed. Run `bun run emails:check-loops` to verify the actual Loops drafts.",
		"",
		"| Flow | Audience | Schedule after entry | Emails |",
		"| --- | --- | --- | --- |",
		...journeys.map(
			(journey) =>
				`| [${cell(journey.name.replace("Cap | ", ""))}](${flowUrl(journey.key)}) | ${journey.audience} | ${flowSteps(
					journey,
				)
					.map((message) => `Day ${message.day}`)
					.join(", ")} | ${journey.messages.length} |`,
		),
		"",
		"All journeys require global subscription, positive Cap consent, the exact audience, lifecycle enabled and onboarding eligible. These filters continue to apply downstream. Free/former promotional flows additionally exclude teammates and require promotional eligibility. Customer and teammate flows still require marketing consent.",
		"",
		"Teammate history takes priority over paid/free classification. Ambiguous contacts receive no journey. [Audience classification and consent](../scripts/loops/README.md#audience-rules).",
		"",
	];
	for (const journey of journeys) {
		lines.push(
			`### ${journey.name.replace("Cap | ", "")}`,
			"",
			`Entry: capLifecycleStage changes into ${journey.key}. Re-entry is disabled. Delays below are relative to the previous step; day numbers are cumulative from entry.`,
			"",
			`Downstream conditions: ${workflowFilter(journey)
				.conditions.map(
					(condition) =>
						`${condition.key} ${condition.operator}${"value" in condition ? ` ${condition.value}` : ""}`,
				)
				.join("; ")}.`,
			"",
			"```mermaid",
			"flowchart TD",
			`  entry["Stage becomes ${journey.key}"] --> guard["Consent and audience guards"]`,
		);
		let previous = "guard";
		for (const [index, message] of flowSteps(journey).entries()) {
			if (message.delayDays) {
				lines.push(
					`  ${previous} --> wait${index}["Wait ${message.delayDays} days"]`,
				);
				previous = `wait${index}`;
			}
			if (message.onlyIf) {
				lines.push(
					`  ${previous} --> branch${index}{"${message.onlyIf.property} is ${message.onlyIf.value}?"}`,
					`  branch${index} -->|Yes| email${index}["Day ${message.day}: ${message.key}"]`,
					`  branch${index} -->|No: skip| next${index}((Continue))`,
					`  email${index} --> next${index}`,
				);
				previous = `next${index}`;
			} else {
				lines.push(
					`  ${previous} --> email${index}["Day ${message.day}: ${message.key}"]`,
				);
				previous = `email${index}`;
			}
		}
		lines.push(
			`  ${previous} --> exit["End"]`,
			"```",
			"",
			"| Day | Subject and source | Send condition |",
			"| --- | --- | --- |",
			...flowSteps(journey).map(
				(message) =>
					`| ${message.day} | ${sourceLink(sourceFor(message), cell(message.subject))} | ${message.onlyIf ? `\`${message.onlyIf.property}=${message.onlyIf.value}\`` : "Journey guards"} |`,
			),
			"",
		);
	}
	lines.push(
		"## Campaign templates",
		"",
		"Campaigns are manually scheduled product updates, with no automatic enrollment. Both require subscription, positive consent and their exact audience. The free template also requires promotional eligibility and excludes teammates.",
		"",
		"| Campaign | Audience | Subject and source | Loops ID |",
		"| --- | --- | --- | --- |",
		...campaignTemplates.map(
			(email) =>
				`| ${cell(email.name.replace("Cap | ", ""))} | ${email.audience} | ${sourceLink(sourceFor(email), cell(email.subject))} | \`${resourceIds[email.key]}\` |`,
		),
		"",
		"## Branding and personalization",
		"",
		`Shared theme, header, signature, sender and fallbacks: ${sourceLink("emails/brand.ts")}.`,
		"",
		`Sender: ${sender.fromName}; local part \`${sender.fromEmail}\` on the Loops sending domain. Reply-to: ${sender.replyToEmail}. Theme: ${theme.name}.`,
		"",
		`Shared components: ${components.map((component) => component.name).join("; ")}.`,
		"",
		"Customer welcome variations come from [customer-copy.ts](customer-copy.ts); eligibility is resolved from account and license state in the profile sync.",
		"",
		"| Plan | Welcome variation |",
		"| --- | --- |",
		...Object.values(customerCopy).map(
			(copy) => `| ${copy.plan} | ${cell(copy.welcome)} |`,
		),
		"",
		"## Marketing email copy",
		"",
		"The excerpts below show content, not an email-client render. Branding and required Loops footer content are composed separately.",
		"",
	);
	for (const email of marketingEmails) {
		lines.push(
			`### ${email.id}`,
			"",
			email.purpose,
			"",
			`**Subject:** ${email.subject}`,
			"",
			`**Preview:** ${email.previewText}`,
			"",
			`**Variables:** ${email.variables.map((key) => `\`contact.${key}\` (fallback: ${contactFallbacks[key]})`).join("; ")}`,
			"",
			`**Edit:** ${sourceLink(sourceFor(email))}`,
			"",
			...email.body
				.replace(/<\/(Paragraph|Button)>/g, "\n\n")
				.replace(/<Br\s*\/>/g, "\n")
				.replace(/<[^>]+>/g, "")
				.trim()
				.split("\n"),
			"",
		);
	}
	lines.push(
		"## Application emails",
		"",
		"These are repository send paths and retained templates, not confirmation of production delivery. They continue through Resend and keep their existing React Email layouts. Loops audience filters do not control them. Shared marketing branding does not automatically restyle these templates.",
		"",
		"| Email | Trigger | Recipients | Template |",
		"| --- | --- | --- | --- |",
		...applicationEmails.map(
			(email) =>
				`| ${email.name} | ${cell(email.trigger)} | ${cell(email.recipients)} | ${sourceLink(`packages/database/emails/${email.template}.tsx`, email.template)} |`,
		),
		"",
	);
	for (const email of applicationEmails) {
		lines.push(
			`### ${email.name}`,
			"",
			email.notes,
			"",
			`Send source: ${email.sources.length ? email.sources.map((source) => sourceLink(source)).join(", ") : "No current call site"}.`,
			"",
		);
	}
	return `${lines.join("\n").trim()}\n`;
};

export const catalogPath = fileURLToPath(new URL("emails/CATALOG.md", root));
