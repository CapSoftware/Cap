import { describe, expect, it } from "vitest";
import {
	maskEmail,
	needsOnboarding,
	onboardingContinuePath,
	onboardingHrefForIntent,
	onboardingIntentFromNextPath,
	onboardingProgressIndex,
	onboardingThemeFromCookie,
	resolveOnboardingStep,
	resolveOnboardingTheme,
	splitFullName,
} from "@/app/(org)/onboarding/onboarding-flow";

describe("needsOnboarding", () => {
	it("requires a name", () => {
		expect(needsOnboarding({ name: null, onboardingSteps: null })).toBe(true);
		expect(needsOnboarding({ name: "   ", onboardingSteps: null })).toBe(true);
	});

	it("keeps new accounts in onboarding until they pick a start", () => {
		expect(
			needsOnboarding({ name: "Ada", onboardingSteps: { getStarted: false } }),
		).toBe(true);
		expect(
			needsOnboarding({ name: "Ada", onboardingSteps: { getStarted: true } }),
		).toBe(false);
	});

	it("leaves existing named accounts alone", () => {
		expect(needsOnboarding({ name: "Ada", onboardingSteps: null })).toBe(false);
		expect(needsOnboarding({ name: "Ada", onboardingSteps: {} })).toBe(false);
	});
});

describe("resolveOnboardingStep", () => {
	it("sends unnamed users to the name step", () => {
		expect(resolveOnboardingStep("start", { name: null })).toEqual({
			kind: "redirect",
			step: "welcome",
		});
		expect(resolveOnboardingStep("welcome", { name: null })).toEqual({
			kind: "render",
			step: "welcome",
		});
	});

	it("moves named users past the name step", () => {
		expect(resolveOnboardingStep("welcome", { name: "Ada" })).toEqual({
			kind: "redirect",
			step: "start",
		});
		expect(resolveOnboardingStep(undefined, { name: "Ada" })).toEqual({
			kind: "redirect",
			step: "start",
		});
	});

	it("renders the start and path steps", () => {
		for (const step of ["start", "loom", "record", "upload"] as const) {
			expect(resolveOnboardingStep(step, { name: "Ada" })).toEqual({
				kind: "render",
				step,
			});
		}
	});

	it("redirects the old step urls", () => {
		expect(
			resolveOnboardingStep("organization-setup", { name: "Ada" }),
		).toEqual({ kind: "redirect", step: "start" });
		expect(resolveOnboardingStep("custom-domain", { name: "Ada" })).toEqual({
			kind: "redirect",
			step: "start",
		});
		expect(resolveOnboardingStep("invite-team", { name: "Ada" })).toEqual({
			kind: "redirect",
			step: "start",
		});
		expect(resolveOnboardingStep("download", { name: "Ada" })).toEqual({
			kind: "redirect",
			step: "record",
		});
		expect(resolveOnboardingStep("nope", { name: "Ada" })).toEqual({
			kind: "redirect",
			step: "start",
		});
	});
});

describe("onboardingIntentFromNextPath", () => {
	it("reads a Loom import link", () => {
		expect(
			onboardingIntentFromNextPath(
				"/dashboard/import/loom?url=https%3A%2F%2Fwww.loom.com%2Fshare%2Fabc1234567",
			),
		).toEqual({
			kind: "loom",
			loomUrl: "https://www.loom.com/share/abc1234567",
			bulk: false,
		});
		expect(
			onboardingIntentFromNextPath("/dashboard/import/loom?mode=csv"),
		).toEqual({ kind: "loom", loomUrl: undefined, bulk: true });
	});

	it("reads upload and record destinations", () => {
		expect(onboardingIntentFromNextPath("/dashboard/import/file")).toEqual({
			kind: "upload",
		});
		expect(onboardingIntentFromNextPath("/dashboard/import")).toEqual({
			kind: "upload",
		});
		expect(onboardingIntentFromNextPath("/dashboard/caps/record")).toEqual({
			kind: "record",
		});
	});

	it("keeps other destinations to continue to afterwards", () => {
		expect(
			onboardingIntentFromNextPath("/dashboard/settings/billing?tab=plan"),
		).toEqual({
			kind: "elsewhere",
			path: "/dashboard/settings/billing?tab=plan",
		});
	});

	it("ignores the dashboard home, onboarding and other origins", () => {
		expect(onboardingIntentFromNextPath(undefined)).toBeNull();
		expect(onboardingIntentFromNextPath("/dashboard")).toBeNull();
		expect(onboardingIntentFromNextPath("/dashboard/caps")).toBeNull();
		expect(onboardingIntentFromNextPath("/onboarding/start")).toBeNull();
		expect(onboardingIntentFromNextPath("/invite/abc123")).toBeNull();
		expect(onboardingIntentFromNextPath("https://evil.example/x")).toBeNull();
		expect(onboardingIntentFromNextPath("//evil.example/x")).toBeNull();
	});
});

describe("onboarding hrefs", () => {
	it("routes each intent to its step", () => {
		expect(
			onboardingHrefForIntent({
				kind: "loom",
				loomUrl: "https://www.loom.com/share/abc1234567",
				bulk: true,
			}),
		).toBe(
			"/onboarding/loom?url=https%3A%2F%2Fwww.loom.com%2Fshare%2Fabc1234567&bulk=1",
		);
		expect(onboardingHrefForIntent({ kind: "upload" })).toBe(
			"/onboarding/upload",
		);
		expect(onboardingHrefForIntent({ kind: "record" })).toBe(
			"/onboarding/record",
		);
		expect(
			onboardingHrefForIntent({ kind: "elsewhere", path: "/dashboard/spaces" }),
		).toBe("/onboarding/start");
		expect(onboardingHrefForIntent(null)).toBe("/onboarding/start");
	});

	it("continues to the remembered destination", () => {
		expect(
			onboardingContinuePath({ kind: "elsewhere", path: "/dashboard/spaces" }),
		).toBe("/dashboard/spaces");
		expect(onboardingContinuePath(null)).toBe("/dashboard/caps");
	});

	it("maps steps onto three progress marks", () => {
		expect(onboardingProgressIndex("welcome")).toBe(0);
		expect(onboardingProgressIndex("start")).toBe(1);
		expect(onboardingProgressIndex("loom")).toBe(2);
		expect(onboardingProgressIndex("upload")).toBe(2);
	});
});

describe("splitFullName", () => {
	it("splits the first word from the rest", () => {
		expect(splitFullName("  Ada  Lovelace King ")).toEqual({
			firstName: "Ada",
			lastName: "Lovelace King",
		});
		expect(splitFullName("Cher")).toEqual({ firstName: "Cher", lastName: "" });
	});
});

describe("maskEmail", () => {
	it("hides most of the mailbox name", () => {
		expect(maskEmail("richie@cap.so")).toBe("ri••••@cap.so");
		expect(maskEmail("jo@cap.so")).toBe("j•••@cap.so");
		expect(maskEmail("nadia.1791348130278@example.com")).toBe(
			"na•••••@example.com",
		);
		expect(maskEmail("not-an-email")).toBe("not-an-email");
	});
});

describe("onboarding theme", () => {
	it("follows the device unless the app theme was chosen", () => {
		expect(onboardingThemeFromCookie(undefined)).toBe("system");
		expect(onboardingThemeFromCookie("purple")).toBe("system");
		expect(onboardingThemeFromCookie("dark")).toBe("dark");
		expect(onboardingThemeFromCookie("light")).toBe("light");
	});

	it("resolves the device preference", () => {
		expect(resolveOnboardingTheme("system", true)).toBe("dark");
		expect(resolveOnboardingTheme("system", false)).toBe("light");
		expect(resolveOnboardingTheme("light", true)).toBe("light");
		expect(resolveOnboardingTheme("dark", false)).toBe("dark");
	});
});
