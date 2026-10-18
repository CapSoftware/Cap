import { PublicCollection } from "@cap/web-domain";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

const decode = Schema.decodeUnknownResult(
	PublicCollection.PublicPageSettingsUpdate,
);

describe("PublicPageSettingsUpdate", () => {
	it("accepts a valid partial patch", () => {
		const result = decode({ title: "Launch videos", gridColumns: 3 });
		expect(Result.isSuccess(result)).toBe(true);
	});

	it("strips logoUrl — only the upload action may write it", () => {
		const result = decode({
			logoUrl: "organizations/other-org/logo.svg",
			title: "t",
		});
		expect(Result.isSuccess(result)).toBe(true);
		if (Result.isSuccess(result)) {
			expect("logoUrl" in result.success).toBe(false);
		}
	});

	it("rejects oversized text fields", () => {
		const over = (length: number) => "x".repeat(length + 1);
		expect(
			Result.isFailure(
				decode({
					title: over(PublicCollection.PUBLIC_PAGE_TITLE_MAX_LENGTH),
				}),
			),
		).toBe(true);
		expect(
			Result.isFailure(
				decode({
					subtitle: over(PublicCollection.PUBLIC_PAGE_SUBTITLE_MAX_LENGTH),
				}),
			),
		).toBe(true);
		expect(
			Result.isFailure(
				decode({
					ctaLabel: over(PublicCollection.PUBLIC_PAGE_CTA_LABEL_MAX_LENGTH),
				}),
			),
		).toBe(true);
		expect(
			Result.isFailure(
				decode({
					ctaUrl: over(PublicCollection.PUBLIC_PAGE_CTA_URL_MAX_LENGTH),
				}),
			),
		).toBe(true);
	});

	it("rejects values outside the literal unions", () => {
		expect(Result.isFailure(decode({ gridColumns: 7 }))).toBe(true);
		expect(Result.isFailure(decode({ layout: "carousel" }))).toBe(true);
		expect(Result.isFailure(decode({ logoMode: "remote" }))).toBe(true);
		expect(Result.isFailure(decode({ hideTitle: "yes" }))).toBe(true);
	});
});
