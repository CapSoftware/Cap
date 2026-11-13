import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
	NEXT_PUBLIC_IS_CAP: "true" as string | undefined,
	NEXT_PUBLIC_INFRA_FILM_URL: undefined as string | undefined,
}));

vi.mock("@cap/env", () => ({ buildEnv: env }));
vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("next/font/google", () => {
	const font = () => ({ className: "", variable: "" });
	return { Geist: font, Geist_Mono: font };
});
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-query")>()),
	useMutation: () => ({ mutate: vi.fn(), isPending: false, reset: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/dashboard/infra/app-1/billing",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@number-flow/react", async () => {
	const { createElement } = await import("react");
	return {
		default: ({ value }: { value: number }) =>
			createElement("span", null, String(value)),
	};
});
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => "id",
	nanoIdLength: 15,
}));

import type { BillingAccount } from "@/app/(infra)/dashboard/infra/[appId]/billing/billing-view";
import { parseAmount } from "@/components/pages/infra/amount";
import { CAP_INFRA_AGENT_PROMPT } from "@/data/infra-agent-prompt";
import {
	INFRA_DELIVERY_BILLED_FROM_TEXT,
	INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES,
	INFRA_DELIVERY_PRICE,
	INFRA_DELIVERY_PRICE_TEXT,
	INFRA_DELIVERY_PRICE_UNIT,
	INFRA_RESOLUTION_TIERS,
	INFRA_SPEECH_DOLLARS_PER_HOUR,
	INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
} from "@/lib/infra-pricing";
import { PRO_MONTHLY_CREDIT_DOLLARS } from "@/lib/infra-pro-credit";
import { getDocBySlug } from "@/utils/docs";

const rest = getDocBySlug("api/rest-api")?.content ?? "";
const billing = getDocBySlug("api/billing")?.content ?? "";
const getStarted = getDocBySlug("api/get-started")?.content ?? "";

const PAGE_DIR = path.join(process.cwd(), "components/pages/infra");

const pageSources = () =>
	fs
		.readdirSync(PAGE_DIR)
		.filter((file) => /\.(ts|tsx|css)$/.test(file))
		.map((file) => ({
			file,
			text: fs.readFileSync(path.join(PAGE_DIR, file), "utf8"),
		}));

const parse = (html: string) => new JSDOM(html).window.document;

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
			content.PLAYER.find((entry) => entry.id === "embed")?.code,
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
		expect(content.PRICES.deliveryPer1000Minutes).toBe(
			INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES,
		);
		expect(content.PRICES.proMonthlyCredit).toBe(PRO_MONTHLY_CREDIT_DOLLARS);
		expect(content.TIERS).toEqual(INFRA_RESOLUTION_TIERS);

		const priced = content.PRICE_ROWS.filter((row) => row.rates);
		expect(priced.map((row) => row.meter)).toEqual(["Storage"]);
		expect(priced[0]?.rates).toEqual(
			INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
		);
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
			"Three things are charged: stored video, delivered video and speech to text. Uploading and encoding are free.",
		);
		expect(
			content.PRICE_ROWS.filter((row) => row.unit).map((row) => row.meter),
		).toEqual(["Storage", "Delivery"]);

		const text = [
			content.infraSeo.description,
			content.infraSeo.ogDescription,
			content.infraSoftwareSchema.offers.description,
			...content.infraFaqs.flatMap((faq) => [faq.question, faq.answer]),
			...content.VIDEO_OUTPUTS.flatMap((item) => [item.name, item.detail]),
			...pageSources().map((source) => source.text),
		].join("\n");

		expect(text).not.toMatch(/\bwatched\b|\bwebhooks?\b/i);
		expect(text).not.toContain(String.fromCodePoint(0x2014));
	});

	it("states the first month of storage in the words the docs use", async () => {
		const content = await load("true");

		expect(billing).toContain(content.STORAGE_RULE);
		expect(getStarted).toContain(content.STORAGE_RULE);
		expect(
			content.infraFaqs.find(
				(faq) => faq.question === "What does Cap Infra charge for?",
			)?.answer,
		).toBe(
			`Three things: stored video, delivered video and speech to text. ${content.STORAGE_RULE} ${content.DELIVERY_RULE}`,
		);
		expect(
			pageSources().find((source) => source.file === "Pricing.tsx")?.text,
		).toContain("{STORAGE_RULE}");
	});

	it("lets anyone start building on Cap's own deployment", async () => {
		const content = await load("true");

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

describe("the rendered page", () => {
	it("renders every section with headings in order and working anchors", async () => {
		const content = await load("true");
		const { InfraPage } = await import("@/components/pages/infra/InfraPage");
		const html = renderToStaticMarkup(React.createElement(InfraPage));

		const page = parse(html);
		const text = page.body.textContent ?? "";

		const levels = [...page.querySelectorAll("h1,h2,h3,h4,h5,h6")].map(
			(heading) => Number(heading.tagName.slice(1)),
		);
		expect(levels.filter((level) => level === 1)).toHaveLength(1);
		expect(levels[0]).toBe(1);
		for (const [index, level] of levels.entries()) {
			expect(level - (levels[index - 1] ?? 1)).toBeLessThanOrEqual(1);
		}

		const anchors = [...page.querySelectorAll('a[href^="#"]')].map(
			(link) => link.getAttribute("href")?.slice(1) ?? "",
		);
		expect(anchors.length).toBeGreaterThan(0);
		for (const anchor of anchors) {
			expect(page.getElementById(anchor), anchor).not.toBeNull();
		}
		for (const anchor of Object.values(content.ANCHORS)) {
			expect(page.getElementById(anchor), anchor).not.toBeNull();
		}

		const embed = content.PLAYER.find((entry) => entry.id === "embed")?.code;
		expect(embed).toContain('loading="lazy"');
		expect(text).toContain(embed);
		expect(text).toContain("Start building");
		expect(text).not.toContain("Request access");
		expect(text).not.toContain("in preview");
		for (const image of page.querySelectorAll("img")) {
			expect(image.hasAttribute("alt")).toBe(true);
			const eager =
				image.hasAttribute("fetchpriority") ||
				(image.getAttribute("src") ?? "").includes("plain-lit");
			if (!eager) expect(image.getAttribute("loading")).toBe("lazy");
		}
	});

	it("prices speech to text on its own row, outside the resolution table", async () => {
		await load("true");
		const { Pricing } = await import("@/components/pages/infra/Pricing");
		const page = parse(renderToStaticMarkup(React.createElement(Pricing)));
		const speech = `$${INFRA_SPEECH_DOLLARS_PER_HOUR.toFixed(2)}`;
		const table = page.querySelector("table");

		expect(table?.querySelector("caption")?.textContent).toBe(
			"Cap Infra prices by resolution",
		);
		expect(table?.textContent).not.toContain("Speech to text");
		expect(table?.textContent).not.toContain(speech);

		const row = [...page.querySelectorAll("dl")].find(
			(list) =>
				list.querySelector("dt")?.textContent?.trim() === "Speech to text",
		);
		expect(row).toBeDefined();
		expect(row?.closest("table")).toBeNull();
		expect(row?.querySelector("dd")?.textContent).toBe(
			`${speech} per audio hour`,
		);
	});

	it("says a month of storage only where billing would agree", async () => {
		const content = await load("true");
		const stored = content.PRO_CREDIT_COVERS[0];
		const days31 =
			(stored.amount / 1000) *
			INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH["1080p"] *
			(31 / 30);

		expect(stored.unit).toBe("minutes stored for 30 days");
		expect(
			(stored.amount / 1000) *
				INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH["1080p"],
		).toBeLessThanOrEqual(PRO_MONTHLY_CREDIT_DOLLARS);
		expect(days31).toBeGreaterThan(PRO_MONTHLY_CREDIT_DOLLARS);
		expect(billing).toContain("A month is counted as 30 days");
	});
});

describe("delivery pricing", () => {
	const PRICE_PATTERN = /\$(\d+(?:\.\d+)?) per 1,000 delivered minutes/g;
	const MEASURE =
		"A delivered minute is a minute of video your viewers' players download. For HLS it counts the exact seconds of the segments served, from each segment's EXTINF duration and EXT-X-BYTERANGE range. For MP4 downloads it counts the bytes served divided by the file's average bytes per second.";
	const DEFINITION = `${MEASURE} Playlists, posters, \`HEAD\` requests, responses other than \`200\` or \`206\` and empty responses are never counted.`;
	const PLAIN_DEFINITION = `${MEASURE} Playlists, posters, HEAD requests, responses other than 200 or 206 and empty responses are never counted.`;
	const FREE_DELIVERY = [
		/\b(?:delivery|delivered|streaming|streams?|bandwidth|egress|playback|views?)\b[^.\n]*\b(?:free|unmetered|unlimited|included|not charged|no charge)\b/i,
		/\b(?:free|unmetered|unlimited|included)\b[^.\n]*\b(?:delivery|streaming|bandwidth|egress)\b/i,
	];

	const readTree = (dir: string): { file: string; text: string }[] =>
		fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) return readTree(full);
			if (!/\.(ts|tsx|mdx|txt)$/.test(entry.name)) return [];
			return [{ file: full, text: fs.readFileSync(full, "utf8") }];
		});

	const llmsInfra = () =>
		["public/llms-full.txt", "public/llms.txt"]
			.flatMap((file) =>
				fs.readFileSync(path.join(process.cwd(), file), "utf8").split("\n"),
			)
			.filter((line) => /Cap Infra|\/api\/developer|delivered/.test(line))
			.join("\n");

	const sourceSurfaces = () => [
		...pageSources(),
		...readTree(path.join(process.cwd(), "app/(infra)/dashboard/infra")),
		...readTree(path.join(process.cwd(), "../../packages/infra-mcp/src")),
		...["lib/developer-openapi.ts", "data/infra-agent-prompt.ts"].map(
			(file) => ({
				file,
				text: fs.readFileSync(path.join(process.cwd(), file), "utf8"),
			}),
		),
	];

	it("states the one delivery price exactly once on the /infra page, in the docs, in the llms file and on the console Billing page", async () => {
		await load("true");
		const { InfraPage } = await import("@/components/pages/infra/InfraPage");
		const { BillingView } = await import(
			"@/app/(infra)/dashboard/infra/[appId]/billing/billing-view"
		);
		const { getAllDocs } = await import("@/utils/docs");
		const landing =
			parse(renderToStaticMarkup(React.createElement(InfraPage))).body
				.textContent ?? "";
		const consoleText = (account: BillingAccount | null) =>
			parse(
				renderToStaticMarkup(
					React.createElement(BillingView, {
						app: { id: "app-1", name: "Fixture" },
						account,
						proCredit: {
							status: "not_pro",
							nextDate: "2026-12-01T00:00:00Z",
						},
						standing: { state: "active", pausesAt: null },
						shortfallMicroCredits: 0,
						autoTopUpFailure: null,
						transactions: [],
						ledgerPage: { newer: null, older: null },
					}),
				),
			).body.textContent ?? "";
		const docs = getAllDocs()
			.filter((doc) => doc.slug.startsWith("api/"))
			.map((doc) => doc.content)
			.join("\n");
		const occurrences = (text: string, needle: string) =>
			text.split(needle).length - 1;

		expect(INFRA_DELIVERY_PRICE).toBe(
			`$${INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES.toFixed(2)}`,
		);
		expect(INFRA_DELIVERY_PRICE_TEXT).toBe(
			`${INFRA_DELIVERY_PRICE} ${INFRA_DELIVERY_PRICE_UNIT}`,
		);
		for (const [surface, text] of Object.entries({
			landing,
			console: consoleText({
				balanceMicroCredits: 0,
				hasCard: false,
				autoTopUpEnabled: false,
				autoTopUpThresholdMicroCredits: 0,
				autoTopUpAmountCents: 0,
			}),
			docs,
			llms: llmsInfra(),
		})) {
			expect(occurrences(text, INFRA_DELIVERY_PRICE), surface).toBe(1);
			for (const match of text.matchAll(PRICE_PATTERN)) {
				expect(`$${match[1]}`, surface).toBe(INFRA_DELIVERY_PRICE);
			}
			expect(occurrences(text, INFRA_DELIVERY_PRICE_UNIT), surface).toBe(1);
			expect(text, surface).not.toMatch(/\bmux\b/i);
		}
		expect(occurrences(docs, INFRA_DELIVERY_PRICE_TEXT)).toBe(1);
		expect(occurrences(llmsInfra(), INFRA_DELIVERY_PRICE_TEXT)).toBe(1);

		for (const doc of [billing, rest, getStarted, llmsInfra()]) {
			expect(doc).toContain(DEFINITION);
		}
		expect(landing).toContain(PLAIN_DEFINITION);
		expect(occurrences(billing, INFRA_DELIVERY_BILLED_FROM_TEXT)).toBe(1);
		expect(INFRA_DELIVERY_BILLED_FROM_TEXT).toBe(
			"Delivery is billed from 14 November 2026. Earlier days are not charged.",
		);
		expect(
			occurrences(consoleText(null), INFRA_DELIVERY_BILLED_FROM_TEXT),
		).toBe(1);

		for (const source of sourceSurfaces()) {
			if (source.file.endsWith(".css")) continue;
			expect(source.text, source.file).not.toContain(INFRA_DELIVERY_PRICE);
			expect(source.text, source.file).not.toMatch(
				new RegExp(PRICE_PATTERN.source),
			);
		}
	});

	it("never says delivery, streaming or bandwidth is free on an Infra surface", async () => {
		const content = await load("true");
		const { InfraPage } = await import("@/components/pages/infra/InfraPage");
		const page = parse(renderToStaticMarkup(React.createElement(InfraPage)));

		const surfaces = [
			{ file: "page", text: page.body.textContent ?? "" },
			{ file: "billing", text: billing },
			{ file: "rest", text: rest },
			{ file: "getStarted", text: getStarted },
			{ file: "llms", text: llmsInfra() },
			{
				file: "content",
				text: [
					content.infraSeo.description,
					content.infraSoftwareSchema.offers.description,
					...content.infraFaqs.map((faq) => faq.answer),
					...content.PRICE_ROWS.map((row) =>
						[row.meter, row.unit, row.price, row.note].join(" "),
					),
				].join("\n"),
			},
			...sourceSurfaces(),
		];
		for (const { file, text } of surfaces) {
			for (const pattern of FREE_DELIVERY) {
				expect(text, file).not.toMatch(pattern);
			}
		}
		expect(billing).toContain(
			"Three things are charged: stored video, delivered video and speech to text.",
		);
		expect(billing).not.toMatch(/\bfrom today\b/i);
	});
});

describe("the film", () => {
	const names = {
		hls: "master.m3u8",
		mp4: "video.mp4",
		poster: "poster.jpg",
	} as const;
	const under = (base: string) => ({
		hls: `${base}/${names.hls}`,
		mp4: `${base}/${names.mp4}`,
		poster: `${base}/${names.poster}`,
	});

	beforeEach(() => {
		env.NEXT_PUBLIC_INFRA_FILM_URL = undefined;
	});

	it("plays from the default base when no other is set", async () => {
		const { FILM_DEFAULT_BASE, filmFiles } = await import(
			"@/components/pages/infra/film-source"
		);

		expect(FILM_DEFAULT_BASE).toMatch(
			/^https:\/\/cap\.so\/api\/developer\/playback\/[\w-]+$/,
		);
		expect(filmFiles(undefined)).toEqual(under(FILM_DEFAULT_BASE));
		expect(filmFiles("")).toEqual(under(FILM_DEFAULT_BASE));
		expect(filmFiles("   ")).toEqual(under(FILM_DEFAULT_BASE));
	});

	it("plays from the configured base when one is set", async () => {
		const { filmFiles } = await import("@/components/pages/infra/film-source");

		expect(filmFiles("https://media.example.com/film")).toEqual(
			under("https://media.example.com/film"),
		);
		expect(filmFiles(" https://media.example.com/film// ")).toEqual(
			under("https://media.example.com/film"),
		);
	});

	it.each([
		["unset", undefined],
		["empty", ""],
		["set", "https://media.example.com/film"],
	])("renders the button with the base %s", async (_name, value) => {
		env.NEXT_PUBLIC_INFRA_FILM_URL = value;
		vi.resetModules();
		const { Hero } = await import("@/components/pages/infra/Hero");
		const page = parse(renderToStaticMarkup(React.createElement(Hero)));
		const buttons = [...page.querySelectorAll("button")].map((button) =>
			button.textContent?.trim(),
		);

		expect(buttons).toContain("Watch the film");
		expect(page.querySelector("dialog")?.hasAttribute("open")).toBe(false);
		expect(page.querySelectorAll("video, iframe")).toHaveLength(0);
		expect(page.documentElement.outerHTML).not.toContain("/playback/");
		expect(page.documentElement.outerHTML).not.toContain("media.example.com");
	});
});

describe("the agent section", () => {
	const CLI = /\bCLI\b|install-cli|\bcap (?:auth|developers|guide|version)\b/i;

	it("describes a CLI only when the prompt uses one", async () => {
		const content = await load("true");
		const section = fs.readFileSync(path.join(PAGE_DIR, "Agent.tsx"), "utf8");
		const copy = [content.AGENT_SUMMARY, content.AGENT_TOOLS, section];

		expect(CLI.test("Your agent installs the Cap CLI")).toBe(true);
		expect(CLI.test("run cap developers list --json")).toBe(true);
		expect(CLI.test(CAP_INFRA_AGENT_PROMPT)).toBe(false);
		if (!CLI.test(CAP_INFRA_AGENT_PROMPT)) {
			for (const text of copy) expect(text).not.toMatch(CLI);
		}
		for (const text of [content.AGENT_SUMMARY, content.AGENT_TOOLS]) {
			expect(text).not.toMatch(/\binstalls?\b/i);
		}
	});

	it("renders the whole prompt, with its first line as the opening", async () => {
		await load("true");
		const { Agent } = await import("@/components/pages/infra/Agent");
		const { CAP_INFRA_AGENT_PROMPT: prompt, CAP_INFRA_POINTER_PROMPT } =
			await import("@/data/infra-agent-prompt");
		const html = renderToStaticMarkup(React.createElement(Agent));
		const page = parse(html);
		const text = page.body.textContent ?? "";
		const [opening = "", ...rest] = prompt.split("\n");

		expect(opening).toBe(
			"Set up Cap Infra in this project so it can upload and play video.",
		);
		expect(page.getElementById("agents")).not.toBeNull();
		expect(text).toContain(opening);
		expect(text).toContain(rest.join("\n").trim());
		expect(text).toContain(CAP_INFRA_POINTER_PROMPT);
		expect(text).toContain("Copy prompt");
		expect(text).not.toContain("Cap Infra is in preview.");
		expect(text).not.toMatch(CLI);
		const hrefs = [...page.querySelectorAll("a")].map((link) =>
			link.getAttribute("href"),
		);
		expect(hrefs).toContain("/docs/api/rest-api");
		expect(hrefs).not.toContain("/docs/agents");
	});

	it("promises only what the prompt asks the agent to do", async () => {
		const content = await load("true");

		expect(content.AGENT_SUMMARY).toContain("reads the API docs");
		expect(CAP_INFRA_AGENT_PROMPT).toContain(
			"https://cap.so/docs/api/rest-api",
		);
		expect(content.AGENT_SUMMARY).toContain("uploads and playback");
		expect(CAP_INFRA_AGENT_PROMPT).toMatch(/upload/i);
		expect(CAP_INFRA_AGENT_PROMPT).toMatch(/embed/i);
		expect(content.AGENT_SUMMARY).toContain(
			"Add your app's secret key to your project",
		);
		expect(CAP_INFRA_AGENT_PROMPT).toContain(
			"put its secret key (csk_) in this project's local environment file",
		);
		expect(content.AGENT_SUMMARY).toContain("keeps the key on the server");
		expect(CAP_INFRA_AGENT_PROMPT).toContain("Keep the key on the server");
	});
});

describe("the calculator's number field", () => {
	it("reads decimals as decimals", () => {
		expect(parseAmount("0.5", 100)).toEqual({ draft: "0.5", value: 0.5 });
		expect(parseAmount("1.5", 100)).toEqual({ draft: "1.5", value: 1.5 });
		expect(parseAmount("0.", 100)).toEqual({ draft: "0.", value: 0 });
		expect(parseAmount(".", 100)).toEqual({ draft: ".", value: 0 });
		expect(parseAmount(".25", 100)).toEqual({ draft: ".25", value: 0.25 });
		expect(parseAmount("1.2.3", 100)).toEqual({ draft: "1.23", value: 1.23 });
		expect(parseAmount("0.129", 100)).toEqual({ draft: "0.12", value: 0.12 });
	});

	it("reads grouped whole numbers and caps at the meter's maximum", () => {
		expect(parseAmount("1,500", 10_000)).toEqual({
			draft: "1500",
			value: 1500,
		});
		expect(parseAmount("", 100)).toEqual({ draft: "", value: 0 });
		expect(parseAmount("abc", 100)).toEqual({ draft: "", value: 0 });
		expect(parseAmount("100", 100)).toEqual({ draft: "100", value: 100 });
		expect(parseAmount("250", 100)).toEqual({ draft: "100", value: 100 });
		expect(parseAmount("200000", 100_000)).toEqual({
			draft: "100000",
			value: 100_000,
		});
	});
});
