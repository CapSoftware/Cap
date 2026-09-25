import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync("public/theme-script.js", "utf8");

function runTheme(
	pathname: string,
	cookie: string,
	systemDark = false,
	delayed = false,
) {
	const classes = new Set(["light", "existing-class"]);
	const body = {
		classList: {
			add: (value: string) => classes.add(value),
			remove: (...values: string[]) =>
				values.forEach((value) => {
					classes.delete(value);
				}),
		},
	};
	const document = { cookie, body: delayed ? null : body };
	let onReady = () => {};
	runInNewContext(script, {
		document,
		window: {
			location: { pathname },
			matchMedia: () => ({ matches: systemDark }),
			addEventListener: (_event: string, callback: () => void) => {
				onReady = callback;
			},
		},
	});
	if (delayed) {
		document.body = body;
		onReady();
	}
	return [...classes];
}

describe("shared page theme initialization", () => {
	it.each(["/s/video", "/s/video/edit", "/s"])(
		"restores saved dark theme on %s",
		(path) => {
			expect(runTheme(path, "theme=dark")).toEqual(["existing-class", "dark"]);
		},
	);
	it("honors explicit light over system dark", () => {
		expect(runTheme("/s/video", "theme=light", true)).toContain("light");
	});
	it("uses system dark when no preference is saved", () => {
		expect(runTheme("/s/video", "", true)).toContain("dark");
	});
	it("ignores unrelated theme cookie names", () => {
		expect(
			runTheme("/s/video", "other_theme=dark; theme=light", true),
		).toContain("light");
	});
	it("waits for the body when loaded in the head", () => {
		expect(runTheme("/s/video", "theme=dark", false, true)).toContain("dark");
	});
	it("preserves marketing pages and dashboard defaults", () => {
		expect(runTheme("/pricing", "theme=dark", true)).toContain("light");
		expect(runTheme("/dashboard/caps", "", true)).toContain("light");
	});
});
