import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthStart } from "./api";
import type { ExtensionSettings } from "./types";

const signInError = (apiBaseUrl: string) =>
	createAuthStart({ apiBaseUrl } as ExtensionSettings).then(
		() => {
			throw new Error("expected sign-in to fail");
		},
		(error: Error) => error.message,
	);

describe("sign-in when the auth route can't be reached", () => {
	beforeEach(() => {
		vi.stubGlobal("chrome", {
			identity: { getRedirectURL: () => "https://abc.chromiumapp.org/" },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("Failed to fetch");
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("tells everyone but a local developer to check their connection", async () => {
		for (const apiBaseUrl of ["https://cap.so", "https://cap.example.com"]) {
			const message = await signInError(apiBaseUrl);
			expect(message).toContain(`Could not reach Cap at ${apiBaseUrl}`);
			expect(message).toContain("Failed to fetch");
			expect(message).not.toContain("dev:extension");
		}
	});

	it("keeps the dev-server hint for a local Cap URL", async () => {
		for (const apiBaseUrl of [
			"http://localhost:3000",
			"http://127.0.0.1:3000",
		]) {
			expect(await signInError(apiBaseUrl)).toContain("bun run dev:extension");
		}
	});
});
