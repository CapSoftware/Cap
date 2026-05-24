import { describe, expect, it } from "vitest";
import { parseStageName } from "./stage";

describe("parseStageName", () => {
	it("recognizes fixed deployment stages", () => {
		expect(parseStageName("staging")).toEqual({ variant: "staging" });
		expect(parseStageName("production")).toEqual({ variant: "production" });
	});

	it("extracts branch names from git branch preview stages", () => {
		expect(parseStageName("git-branch-add-infra-tests")).toEqual({
			variant: "git-branch",
			branch: "add-infra-tests",
		});
	});

	it("rejects unsupported stages", () => {
		expect(() => parseStageName("preview")).toThrow("Unsupported stage");
		expect(() => parseStageName("git-branch-")).toThrow("Unsupported stage");
	});
});
