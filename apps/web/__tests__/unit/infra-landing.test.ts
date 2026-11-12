import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
	NEXT_PUBLIC_IS_CAP: "true" as string | undefined,
}));

vi.mock("@cap/env", () => ({ buildEnv: env }));
vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => "id",
	nanoIdLength: 15,
}));

import {
	INFRA_RESOLUTION_TIERS,
	INFRA_SPEECH_DOLLARS_PER_HOUR,
	INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
} from "@/lib/infra-pricing";
import { PRO_MONTHLY_CREDIT_DOLLARS } from "@/lib/infra-pro-credit";
import { getDocBySlug } from "@/utils/docs";

const rest = getDocBySlug("api/rest-api")?.content ?? "";
const billing = getDocBySlug("api/billing")?.content ?? "";

const PAGE_DIR = path.join(process.cwd(), "components/pages/infra");

const pageSources = () =>
	fs
		.readdirSync(PAGE_DIR)
		.filter((file) => /\.(ts|tsx|css)$/.test(file))
		.map((file) => ({
			file,
			text: fs.readFileSync(path.join(PAGE_DIR, file), "utf8"),
		}));

const load = async (isCap: string | undefined) => {
	env.NEXT_PUBLIC_IS_CAP = isCap;
	vi.resetModules();
	return import("@/components/pages/infra/content");
};

describe("the Cap Infra landing page", () => {
	beforeEach(() => {
		env.NEXT_PUBLIC_IS_CAP = "true";
	});

	it("shows only requests and responses that are in the REST API docs", async () => {
		const content = await load("true");

		expect(rest).not.toBe("");
		for (const sample of [
			content.CREATE_UPLOAD,
			content.GET_VIDEO_STATUS,
			content.VIDEO_STATUS_RESPONSE,
			...content.CREATE_TRANSCRIPT.map((entry) => entry.code),
		]) {
			expect(rest).toContain(sample);
		}
		expect(content.VIDEO_FLOW.map((entry) => entry.code)).toEqual([
			`${content.CREATE_UPLOAD}\n\n${content.GET_VIDEO_STATUS}`,
		]);
		for (const url of Object.values(content.SAMPLE_PLAYBACK)) {
			expect(rest).toContain(url);
		}
		for (const sample of content.PLAYER) {
			expect(
				Object.values(content.SAMPLE_PLAYBACK).some((url) =>
					sample.code.includes(url),
				),
			).toBe(true);
		}
	});

	it("takes every price from the pricing module", async () => {
		const content = await load("true");

		expect(content.PRICES.storagePer1000Minutes).toEqual(
			INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
		);
		expect(content.PRICES.speechPerHour).toBe(INFRA_SPEECH_DOLLARS_PER_HOUR);
		expect(content.PRICES.proMonthlyCredit).toBe(PRO_MONTHLY_CREDIT_DOLLARS);
		expect(content.TIERS).toEqual(INFRA_RESOLUTION_TIERS);

		const priced = content.PRICE_ROWS.filter((row) => row.rates);
		expect(priced.map((row) => row.meter)).toEqual(["Storage"]);
		expect(priced[0]?.rates).toEqual(
			INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
		);
		expect(
			content.PRICE_ROWS.find((row) => row.meter === "Speech to text")?.price,
		).toBe(`$${INFRA_SPEECH_DOLLARS_PER_HOUR.toFixed(2)}`);

		for (const tier of INFRA_RESOLUTION_TIERS) {
			const price = `$${INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH[tier].toFixed(2)}`;
			expect(billing).toContain(`${price} per 1,000 minutes per month`);
			expect(content.infraFaqs.some((faq) => faq.answer.includes(price))).toBe(
				true,
			);
			expect(content.infraSoftwareSchema.offers.description).toContain(price);
		}
	});

	it("charges for what billing charges for and nothing else", async () => {
		const content = await load("true");

		expect(billing).toContain(
			"Two things are charged: stored video and speech to text. Uploading and encoding are free.",
		);
		expect(
			content.PRICE_ROWS.filter((row) => row.unit).map((row) => row.meter),
		).toEqual(["Storage", "Speech to text"]);

		const text = [
			content.infraSeo.description,
			content.infraSeo.ogDescription,
			content.infraSoftwareSchema.offers.description,
			...content.infraFaqs.flatMap((faq) => [faq.question, faq.answer]),
			...content.VIDEO_OUTPUTS.flatMap((item) => [item.name, item.detail]),
			...pageSources().map((source) => source.text),
		].join("\n");

		expect(text).not.toMatch(/\bdelivery\b|\bwatched\b|\bwebhooks?\b/i);
		expect(text).not.toContain(String.fromCodePoint(0x2014));
	});

	it("asks for access while Cap Infra is in preview", async () => {
		const content = await load("true");

		expect(content.OPEN_ACCESS).toBe(false);
		expect(content.START.label).toBe("Request access");
		expect(content.START.href).toBe(
			"mailto:hello@cap.so?subject=Cap%20Infra%20access",
		);
		expect(content.PREVIEW_NOTE).toBe(
			"Cap Infra is in preview. Email hello@cap.so for access.",
		);
		expect(content.infraFaqs[0]?.answer).toBe(content.PREVIEW_NOTE);
	});

	it("opens the console where anyone can use it", async () => {
		const content = await load("false");

		expect(content.OPEN_ACCESS).toBe(true);
		expect(content.START).toEqual({
			label: "Start building",
			href: "/dashboard/infra",
		});
		expect(content.PREVIEW_NOTE).toBeNull();
		expect(
			content.infraFaqs.some((faq) => faq.answer.includes("preview")),
		).toBe(false);
	});

	it("links only to anchors the page has", async () => {
		const content = await load("true");
		const anchors = new Set<string>(Object.values(content.ANCHORS));

		for (const link of content.NAV_LINKS) {
			expect(anchors.has(link.href.slice(1)), link.href).toBe(true);
		}
		for (const source of pageSources()) {
			for (const [, name] of source.text.matchAll(/ANCHORS\.(\w+)/g)) {
				expect(
					Object.keys(content.ANCHORS),
					`${source.file}: ${name}`,
				).toContain(name);
			}
		}
		const heading = content.LINKS.uploadDocs.split("#")[1];
		expect(rest).toMatch(/^#+ Multipart Upload$/m);
		expect(heading).toBe("multipart-upload");
	});
});
