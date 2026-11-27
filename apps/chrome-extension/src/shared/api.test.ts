import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApiRequestError,
	createAuthStart,
	fetchBootstrap,
	SESSION_EXPIRED_MESSAGE,
} from "./api";
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

describe("a rejected extension key", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each([
		[401, SESSION_EXPIRED_MESSAGE],
		[403, "nope"],
	])("reports status %i with a usable message", async (status, message) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status })),
		);
		const error = await fetchBootstrap(
			{ apiBaseUrl: "https://cap.so" } as ExtensionSettings,
			{ authApiKey: "k", userId: "u" },
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error).toMatchObject({ status, message });
	});
});
