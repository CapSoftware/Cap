import { afterEach, describe, expect, it, vi } from "vitest";
import englishMessages from "../../public/_locales/en/messages.json";
import chineseMessages from "../../public/_locales/zh_CN/messages.json";
import { type MessageKey, msg } from "./i18n";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("extension messages", () => {
	it("keeps locale catalogs aligned", () => {
		expect(Object.keys(chineseMessages).sort()).toEqual(
			Object.keys(englishMessages).sort(),
		);
	});

	it("uses the browser locale when a translation is available", () => {
		const getMessage = vi.fn(() => "使用 Cap 录制屏幕");
		vi.stubGlobal("chrome", { i18n: { getMessage } });

		expect(msg("actionDefaultTitle")).toBe("使用 Cap 录制屏幕");
		expect(getMessage).toHaveBeenCalledWith("actionDefaultTitle", undefined);
	});

	it("falls back to English outside an extension context", () => {
		vi.stubGlobal("chrome", undefined);

		expect(msg("actionDefaultTitle")).toBe("Record your screen with Cap");
	});

	it("falls back to English when Chrome i18n is unavailable", () => {
		vi.stubGlobal("chrome", {});

		expect(msg("actionDefaultTitle")).toBe("Record your screen with Cap");
	});

	it("falls back to English when Chrome cannot resolve a message", () => {
		vi.stubGlobal("chrome", {
			i18n: { getMessage: vi.fn(() => "") },
		});

		expect(msg("offscreenJustification")).toBe(
			"Record and upload Cap videos from an extension page.",
		);
	});

	it("applies substitutions to the English fallback", () => {
		const originalMessage = englishMessages.actionDefaultTitle.message;
		vi.stubGlobal("chrome", undefined);

		try {
			englishMessages.actionDefaultTitle.message = "Record $1";
			expect(msg("actionDefaultTitle", "your screen")).toBe(
				"Record your screen",
			);

			englishMessages.actionDefaultTitle.message = "Record $1 with $2";
			expect(msg("actionDefaultTitle", ["your screen", "Cap"])).toBe(
				"Record your screen with Cap",
			);
		} finally {
			englishMessages.actionDefaultTitle.message = originalMessage;
		}
	});

	it.each([undefined, { i18n: { getMessage: () => "" } }])(
		"applies an empty substitution to the English fallback with chrome=%j",
		(chromeApi) => {
			const originalMessage = englishMessages.actionDefaultTitle.message;
			vi.stubGlobal("chrome", chromeApi);

			try {
				englishMessages.actionDefaultTitle.message = "Record $1";
				expect(msg("actionDefaultTitle", "")).toBe("Record ");
			} finally {
				englishMessages.actionDefaultTitle.message = originalMessage;
			}
		},
	);

	it.each([undefined, { i18n: { getMessage: () => "" } }])(
		"preserves escaped dollars in the English fallback with chrome=%j",
		(chromeApi) => {
			const originalMessage = englishMessages.actionDefaultTitle.message;
			vi.stubGlobal("chrome", chromeApi);

			try {
				englishMessages.actionDefaultTitle.message = "Cost $$5";
				expect(msg("actionDefaultTitle")).toBe("Cost $5");

				englishMessages.actionDefaultTitle.message = "$$1: $1 / $2";
				expect(msg("actionDefaultTitle", "$2")).toBe("$1: $2 / ");
				expect(msg("actionDefaultTitle")).toBe("$1:  / ");
				expect(msg("actionDefaultTitle", [])).toBe("$1:  / ");
			} finally {
				englishMessages.actionDefaultTitle.message = originalMessage;
			}
		},
	);

	it.each([undefined, { i18n: { getMessage: () => "" } }])(
		"matches Chrome's single-digit positional substitutions with chrome=%j",
		(chromeApi) => {
			const originalMessage = englishMessages.actionDefaultTitle.message;
			vi.stubGlobal("chrome", chromeApi);

			try {
				englishMessages.actionDefaultTitle.message =
					"$0 | $1 | $9 | $10 | $09 | $100 | $$10";
				expect(
					msg("actionDefaultTitle", [
						"a",
						"b",
						"c",
						"d",
						"e",
						"f",
						"g",
						"h",
						"i",
					]),
				).toBe(" | a | i | a0 | 9 | a00 | $10");
			} finally {
				englishMessages.actionDefaultTitle.message = originalMessage;
			}
		},
	);

	it("returns the key when the English fallback is missing", () => {
		vi.stubGlobal("chrome", undefined);

		expect(msg("missingMessage" as MessageKey)).toBe("missingMessage");
	});
});
