import { afterEach, expect, it, vi } from "vitest";
import { isWebStudioEnabledForEmail } from "@/lib/web-studio-rollout";

afterEach(() => vi.unstubAllEnvs());

function rollout(enabled: string | undefined, allowlist: string | undefined) {
	vi.stubEnv("CAP_WEB_EDITOR_STUDIO_ENABLED", enabled);
	vi.stubEnv("CAP_WEB_EDITOR_STUDIO_ALLOWLIST", allowlist);
}

it("keeps Studio off when the rollout flag is absent", () => {
	rollout(undefined, "pilot@example.com");
	expect(isWebStudioEnabledForEmail("pilot@example.com")).toBe(false);
});

it("keeps Studio off with an empty allowlist", () => {
	rollout("enabled", undefined);
	expect(isWebStudioEnabledForEmail("pilot@example.com")).toBe(false);
});

it("allows listed emails and domains only", () => {
	rollout("enabled", " Pilot@Example.com , @cap.so ");
	expect(isWebStudioEnabledForEmail("pilot@example.com")).toBe(true);
	expect(isWebStudioEnabledForEmail("PILOT@EXAMPLE.COM ")).toBe(true);
	expect(isWebStudioEnabledForEmail("someone@cap.so")).toBe(true);
	expect(isWebStudioEnabledForEmail("someone@example.com")).toBe(false);
	expect(isWebStudioEnabledForEmail("someone@notcap.so")).toBe(false);
	expect(isWebStudioEnabledForEmail(null)).toBe(false);
	expect(isWebStudioEnabledForEmail("not-an-email")).toBe(false);
});

it("allows every account on preview and local deployments with *", () => {
	rollout("enabled", "*");
	vi.stubEnv("VERCEL_ENV", "preview");
	expect(isWebStudioEnabledForEmail("anyone@example.com")).toBe(true);
	vi.stubEnv("VERCEL_ENV", undefined);
	vi.stubEnv("NODE_ENV", "development");
	expect(isWebStudioEnabledForEmail("anyone@example.com")).toBe(true);
});

it("never lets * open Studio to everyone in production", () => {
	rollout("enabled", "*");
	vi.stubEnv("VERCEL_ENV", "production");
	expect(isWebStudioEnabledForEmail("anyone@example.com")).toBe(false);
	vi.stubEnv("VERCEL_ENV", undefined);
	vi.stubEnv("NODE_ENV", "production");
	expect(isWebStudioEnabledForEmail("anyone@example.com")).toBe(false);
});
