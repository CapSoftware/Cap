import { describe, expect, it } from "vitest";
import { buildEmbedCode } from "@/lib/embed-code";
import {
	buildEmbedQuery,
	DEFAULT_EMBED_OPTIONS,
	parseEmbedOptions,
} from "@/lib/embed-options";

const legacyBuildEmbedCode = ({
	webUrl,
	videoId,
	startTime,
}: {
	webUrl: string;
	videoId: string;
	startTime?: number | null;
}): string => {
	const start =
		typeof startTime === "number" && Number.isFinite(startTime) && startTime > 0
			? `?t=${Math.floor(startTime)}`
			: "";

	return `
	<div style="position: relative; padding-bottom: 56.25%; height: 0;">
			<iframe
			src="${webUrl}/embed/${videoId}${start}"
			frameborder="0"
			webkitallowfullscreen
			mozallowfullscreen
			allowfullscreen
			style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"
		></iframe>
	</div>
`
		.trim()
		.replace(/[\n\t]+/g, " ")
		.replace(/>\s+</g, "><")
		.replace(/"\s+>/g, '">');
};

describe("parseEmbedOptions", () => {
	it("defaults to how embeds have always looked", () => {
		expect(parseEmbedOptions({})).toEqual(DEFAULT_EMBED_OPTIONS);
		expect(parseEmbedOptions(null)).toEqual(DEFAULT_EMBED_OPTIONS);
		expect(parseEmbedOptions(new URLSearchParams(""))).toEqual(
			DEFAULT_EMBED_OPTIONS,
		);
	});

	it("only hides things on an explicit false", () => {
		expect(
			parseEmbedOptions({ title: "false", owner: "0", branding: "false" }),
		).toMatchObject({
			showTitle: false,
			showOwner: false,
			showBranding: false,
		});
		expect(
			parseEmbedOptions({ title: "no", owner: "", branding: "true" }),
		).toMatchObject({ showTitle: true, showOwner: true, showBranding: true });
	});

	it("only autoplays and mutes on an explicit true", () => {
		expect(parseEmbedOptions({ autoplay: "true", muted: "1" })).toMatchObject({
			autoplay: true,
			muted: true,
		});
		expect(
			parseEmbedOptions({ autoplay: "yes", muted: "false" }),
		).toMatchObject({ autoplay: false, muted: false });
	});

	it("keeps the existing start time rules", () => {
		expect(parseEmbedOptions({ t: "83" }).startTime).toBe(83);
		expect(parseEmbedOptions({ t: ["12", "40"] }).startTime).toBe(12);
		for (const t of ["0", "-5", "abc", ""]) {
			expect(parseEmbedOptions({ t }).startTime).toBeNull();
		}
	});

	it("takes the first of repeated params", () => {
		expect(parseEmbedOptions({ title: ["false", "true"] }).showTitle).toBe(
			false,
		);
		expect(
			parseEmbedOptions(new URLSearchParams("title=true&title=false"))
				.showTitle,
		).toBe(true);
	});
});

describe("buildEmbedQuery", () => {
	it("is empty for defaults", () => {
		expect(buildEmbedQuery({})).toBe("");
		expect(buildEmbedQuery(DEFAULT_EMBED_OPTIONS)).toBe("");
	});

	it("writes only changed options, in a fixed order", () => {
		expect(
			buildEmbedQuery({
				showBranding: false,
				showTitle: false,
				autoplay: true,
				muted: true,
				showOwner: false,
				startTime: 61.9,
			}),
		).toBe(
			"?t=61&autoplay=true&muted=true&title=false&owner=false&branding=false",
		);
	});

	it("round trips through the parser", () => {
		const options = {
			...DEFAULT_EMBED_OPTIONS,
			showOwner: false,
			autoplay: true,
			muted: true,
			startTime: 30,
		};
		expect(
			parseEmbedOptions(new URLSearchParams(buildEmbedQuery(options))),
		).toEqual(options);
	});
});

describe("buildEmbedCode", () => {
	it("is byte-identical to the previous snippet with default options", () => {
		const cases = [
			{ webUrl: "https://cap.so", videoId: "abc123" },
			{ webUrl: "https://cap.so", videoId: "abc123", startTime: 83 },
			{ webUrl: "https://cap.so", videoId: "abc123", startTime: 83.7 },
			{ webUrl: "https://cap.so", videoId: "abc123", startTime: null },
			{ webUrl: "https://cap.example.com", videoId: "xyz", startTime: 0 },
		];
		for (const input of cases) {
			expect(buildEmbedCode(input)).toBe(legacyBuildEmbedCode(input));
			expect(buildEmbedCode({ ...input, options: {} })).toBe(
				legacyBuildEmbedCode(input),
			);
		}
		expect(
			buildEmbedCode({ webUrl: "https://cap.so", videoId: "abc123" }),
		).toBe(
			'<div style="position: relative; padding-bottom: 56.25%; height: 0;"><iframe src="https://cap.so/embed/abc123" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"></iframe></div>',
		);
	});

	it("adds the options and delegates autoplay to the iframe", () => {
		const code = buildEmbedCode({
			webUrl: "https://cap.so",
			videoId: "abc123",
			startTime: 10,
			options: { autoplay: true, muted: true, showTitle: false },
		});
		expect(code).toContain(
			'src="https://cap.so/embed/abc123?t=10&autoplay=true&muted=true&title=false"',
		);
		expect(code).toContain(
			'frameborder="0" allow="autoplay; fullscreen; picture-in-picture" webkitallowfullscreen',
		);
	});

	it("does not add the allow attribute without autoplay", () => {
		const code = buildEmbedCode({
			webUrl: "https://cap.so",
			videoId: "abc123",
			options: { showBranding: false },
		});
		expect(code).not.toContain("allow=");
		expect(code).toContain('src="https://cap.so/embed/abc123?branding=false"');
	});
});
