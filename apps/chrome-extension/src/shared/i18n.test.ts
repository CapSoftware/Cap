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

	it("returns the key when the English fallback is missing", () => {
		vi.stubGlobal("chrome", undefined);

		expect(msg("missingMessage" as MessageKey)).toBe("missingMessage");
	});
});
