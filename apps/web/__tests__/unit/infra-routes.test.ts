import { describe, expect, it } from "vitest";
import {
	getInfraPageTitle,
	INFRA_SECTIONS,
	infraAppPath,
	isInfraPathname,
	parseInfraPathname,
	resolveLegacyDeveloperPath,
	selectInfraApp,
} from "@/lib/infra-routes";

const app = (id: string, createdAt: string) => ({
	id,
	createdAt: new Date(createdAt),
});

describe("selectInfraApp", () => {
	const apps = [
		app("older", "2026-01-01T00:00:00Z"),
		app("newest", "2026-03-01T00:00:00Z"),
		app("middle", "2026-02-01T00:00:00Z"),
	];

	it("returns null when the user has no apps", () => {
		expect(selectInfraApp([], "anything")).toBeNull();
	});

	it("uses the remembered app when it still belongs to the user", () => {
		expect(selectInfraApp(apps, "older")?.id).toBe("older");
	});

	it("falls back to the most recently created app for a foreign or deleted id", () => {
		expect(selectInfraApp(apps, "someone-elses-app")?.id).toBe("newest");
	});

	it("falls back to the most recently created app without a cookie", () => {
		expect(selectInfraApp(apps, undefined)?.id).toBe("newest");
		expect(selectInfraApp(apps, "")?.id).toBe("newest");
	});
});

describe("resolveLegacyDeveloperPath", () => {
	it.each([
		[[], { kind: "index" }],
		[["apps"], { kind: "index" }],
		[["unknown"], { kind: "index" }],
		[["usage"], { kind: "selected", section: "usage" }],
		[["credits"], { kind: "selected", section: "billing" }],
		[["apps", "a1"], { kind: "app", appId: "a1", section: "" }],
		[
			["apps", "a1", "settings"],
			{ kind: "app", appId: "a1", section: "settings" },
		],
		[
			["apps", "a1", "domains"],
			{ kind: "app", appId: "a1", section: "settings" },
		],
		[["apps", "a1", "api-keys"], { kind: "app", appId: "a1", section: "keys" }],
		[["apps", "a1", "videos"], { kind: "app", appId: "a1", section: "videos" }],
		[["apps", "a1", "constructor"], { kind: "app", appId: "a1", section: "" }],
	])("maps /dashboard/developers/%j", (segments, expected) => {
		expect(resolveLegacyDeveloperPath(segments)).toEqual(expected);
	});
});

describe("infra paths", () => {
	it("builds app paths for every section", () => {
		expect(infraAppPath("a1")).toBe("/dashboard/infra/a1");
		expect(infraAppPath("a1", "billing")).toBe("/dashboard/infra/a1/billing");
		expect(infraAppPath("a/1", "keys")).toBe("/dashboard/infra/a%2F1/keys");
	});

	it("only treats the infra prefix as the infra section", () => {
		expect(isInfraPathname("/dashboard/infra")).toBe(true);
		expect(isInfraPathname("/dashboard/infra/a1/usage")).toBe(true);
		expect(isInfraPathname("/dashboard/infrastructure")).toBe(false);
		expect(isInfraPathname("/dashboard/caps")).toBe(false);
	});

	it("parses the app and section from a pathname", () => {
		expect(parseInfraPathname("/dashboard/infra")).toEqual({
			appId: null,
			section: null,
		});
		expect(parseInfraPathname("/dashboard/infra/a1")).toEqual({
			appId: "a1",
			section: "",
		});
		expect(parseInfraPathname("/dashboard/infra/a1/keys")).toEqual({
			appId: "a1",
			section: "keys",
		});
		expect(parseInfraPathname("/dashboard/infra/a1/nope")).toEqual({
			appId: "a1",
			section: null,
		});
		expect(parseInfraPathname("/dashboard/caps")).toEqual({
			appId: null,
			section: null,
		});
	});

	it("round trips every section through the parser", () => {
		for (const section of INFRA_SECTIONS) {
			expect(parseInfraPathname(infraAppPath("app_1", section.slug))).toEqual({
				appId: "app_1",
				section: section.slug,
			});
		}
	});

	it("titles infra pages", () => {
		expect(getInfraPageTitle("/dashboard/infra")).toBe("Infra");
		expect(getInfraPageTitle("/dashboard/infra/a1")).toBe("Overview");
		expect(getInfraPageTitle("/dashboard/infra/a1/keys")).toBe("API keys");
		expect(getInfraPageTitle("/dashboard/caps")).toBeNull();
	});
});
