import assert from "node:assert/strict";
import { type BrandIds, components, emailContent } from "../../emails/brand";

export const normalizeLmx = (lmx: string) =>
	lmx
		.trim()
		.replace(/>\s*\n\s*</g, "><")
		.replace(
			/<Strong><Link([^>]*)>([^<]*)<\/Link><\/Strong>/g,
			"<Link$1><Strong>$2</Strong></Link>",
		)
		.replace(
			/<(\w+)((?:\s+[\w]+="[^"]*")*)\s*(\/?)>/g,
			(_, tag: string, attributes: string, closing: string) => {
				const normalized = [...attributes.matchAll(/([\w]+)="([^"]*)"/g)]
					.filter(([, key, value]) => key !== "align" || value !== "left")
					.map(([, key, value]) => `${key}="${value}"`)
					.sort();
				return `<${tag}${normalized.length ? ` ${normalized.join(" ")}` : ""}${closing ? " /" : ""}>`;
			},
		);

export const assertEmailContent = (
	actual: Record<string, unknown>,
	message: { subject: string; previewText: string; body: string },
	ids: BrandIds,
) => {
	const expected = emailContent(message, ids);
	for (const [key, value] of Object.entries(expected)) {
		if (key !== "lmx")
			assert.deepEqual(actual[key], value, `Email ${key} differs`);
	}
	assert.equal(typeof actual.lmx, "string");
	let expanded = expected.lmx;
	for (const [index, id] of [ids.header, ids.signature].entries()) {
		expanded = expanded.replace(
			`<Component componentId="${id}" />`,
			`<Component componentId="${id}">${components[index].lmx}</Component>`,
		);
	}
	const normalized = normalizeLmx(actual.lmx as string);
	assert(
		normalized === normalizeLmx(expanded) ||
			normalized === normalizeLmx(expected.lmx),
		"Email LMX differs from local body, branding references or shared component content",
	);
};
