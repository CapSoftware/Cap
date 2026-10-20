import { describe, expect, it } from "vitest";
import { parseAuthRedirect, requireAuthRedirectSession } from "./session";

describe("parseAuthRedirect", () => {
	it("extracts the issued API key and user id", () => {
		expect(
			parseAuthRedirect("cap://auth?api_key=key_123&user_id=user_123"),
		).toEqual({
			apiKey: "key_123",
			userId: "user_123",
		});
	});

	it("rejects redirects without an API key", () => {
		expect(parseAuthRedirect("cap://auth?user_id=user_123")).toBeNull();
	});

	it("rejects redirects without a user id", () => {
		expect(parseAuthRedirect("cap://auth?api_key=key_123")).toBeNull();
	});

	it("throws a usable message for failed auth callbacks", () => {
		expect(() =>
			requireAuthRedirectSession(
				"cap://auth?error_description=Organization%20not%20found",
			),
		).toThrow("Organization not found");
	});

	it("throws when an auth callback omits the mobile API key", () => {
		expect(() =>
			requireAuthRedirectSession("cap://auth?user_id=user_123"),
		).toThrow("Sign in did not return a mobile session.");
	});

	it("throws when an auth callback omits the user id", () => {
		expect(() =>
			requireAuthRedirectSession("cap://auth?api_key=key_123"),
		).toThrow("Sign in did not return a mobile session.");
	});
});
