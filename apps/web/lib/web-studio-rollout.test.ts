import { afterEach, expect, it, vi } from "vitest";
import { isWebStudioEnabledForEmail } from "./web-studio-rollout";

afterEach(() => vi.unstubAllEnvs());

it("keeps Studio disabled when the rollout flag is absent", () => {
	vi.stubEnv("CAP_WEB_EDITOR_STUDIO_ENABLED", undefined);
	expect(isWebStudioEnabledForEmail("richie@mcilroy.co")).toBe(false);
});

it("allows only Richie's signed-in email while the rollout flag is enabled", () => {
	vi.stubEnv("CAP_WEB_EDITOR_STUDIO_ENABLED", "enabled");
	expect(isWebStudioEnabledForEmail("richie@mcilroy.co")).toBe(true);
	expect(isWebStudioEnabledForEmail("RICHIE@MCILROY.CO ")).toBe(true);
	expect(isWebStudioEnabledForEmail("someone@example.com")).toBe(false);
	expect(isWebStudioEnabledForEmail(null)).toBe(false);
});
