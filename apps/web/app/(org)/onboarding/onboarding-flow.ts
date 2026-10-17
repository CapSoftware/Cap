export const ONBOARDING_PATH_STEPS = ["loom", "record", "upload"] as const;
export type OnboardingPathStep = (typeof ONBOARDING_PATH_STEPS)[number];

export const ONBOARDING_STEPS = [
	"welcome",
	"start",
	...ONBOARDING_PATH_STEPS,
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_NEXT_COOKIE = "cap_onboarding_next";
export const THEME_COOKIE = "theme";

export type OnboardingThemePreference = "light" | "dark" | "system";

export const onboardingThemeFromCookie = (
	value: string | undefined,
): OnboardingThemePreference =>
	value === "light" || value === "dark" ? value : "system";

export const resolveOnboardingTheme = (
	preference: OnboardingThemePreference,
	systemPrefersDark: boolean,
) =>
	preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;

const LEGACY_STEP_REDIRECTS: Record<string, OnboardingStep> = {
	"organization-setup": "start",
	"custom-domain": "start",
	"invite-team": "start",
	download: "record",
};

type OnboardingUser = {
	name: string | null;
	onboardingSteps: { getStarted?: boolean } | null;
};

export const hasOnboardingName = (user: Pick<OnboardingUser, "name">) =>
	Boolean(user.name?.trim());

export const needsOnboarding = (user: OnboardingUser) =>
	!hasOnboardingName(user) || user.onboardingSteps?.getStarted === false;

export const isOnboardingStep = (value: string): value is OnboardingStep =>
	(ONBOARDING_STEPS as readonly string[]).includes(value);

export type OnboardingStepResolution =
	| { kind: "render"; step: OnboardingStep }
	| { kind: "redirect"; step: OnboardingStep };

export const resolveOnboardingStep = (
	requested: string | undefined,
	user: Pick<OnboardingUser, "name">,
): OnboardingStepResolution => {
	if (!hasOnboardingName(user)) {
		return requested === "welcome"
			? { kind: "render", step: "welcome" }
			: { kind: "redirect", step: "welcome" };
	}

	if (requested === undefined || requested === "welcome") {
		return { kind: "redirect", step: "start" };
	}

	const legacy = LEGACY_STEP_REDIRECTS[requested];
	if (legacy) return { kind: "redirect", step: legacy };

	if (isOnboardingStep(requested)) return { kind: "render", step: requested };

	return { kind: "redirect", step: "start" };
};

export type OnboardingIntent =
	| { kind: "loom"; loomUrl?: string; bulk: boolean }
	| { kind: "upload" }
	| { kind: "record" }
	| { kind: "elsewhere"; path: string };

const INTENT_BASE = "http://cap.invalid";

export const onboardingIntentFromNextPath = (
	nextPath: string | null | undefined,
): OnboardingIntent | null => {
	if (!nextPath) return null;

	let url: URL;
	try {
		url = new URL(nextPath, INTENT_BASE);
	} catch {
		return null;
	}
	if (url.origin !== INTENT_BASE) return null;

	const pathname = url.pathname.replace(/\/+$/, "") || "/";

	if (pathname === "/dashboard/import/loom") {
		return {
			kind: "loom",
			loomUrl: url.searchParams.get("url")?.trim() || undefined,
			bulk: url.searchParams.get("mode") === "csv",
		};
	}
	if (pathname === "/dashboard/import" || pathname === "/dashboard/import/file")
		return { kind: "upload" };
	if (pathname === "/dashboard/caps/record") return { kind: "record" };
	if (
		pathname === "/" ||
		pathname === "/dashboard" ||
		pathname === "/dashboard/caps" ||
		pathname.startsWith("/onboarding") ||
		pathname.startsWith("/invite/")
	)
		return null;

	return {
		kind: "elsewhere",
		path: `${url.pathname}${url.search}${url.hash}`,
	};
};

export const onboardingStepHref = (
	step: OnboardingStep,
	params?: Record<string, string | undefined>,
) => {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value) query.set(key, value);
	}
	const search = query.toString();
	return `/onboarding/${step}${search ? `?${search}` : ""}`;
};

export const onboardingHrefForIntent = (intent: OnboardingIntent | null) => {
	switch (intent?.kind) {
		case "loom":
			return onboardingStepHref("loom", {
				url: intent.loomUrl,
				bulk: intent.bulk ? "1" : undefined,
			});
		case "upload":
			return onboardingStepHref("upload");
		case "record":
			return onboardingStepHref("record");
		default:
			return onboardingStepHref("start");
	}
};

export const onboardingContinuePath = (intent: OnboardingIntent | null) =>
	intent?.kind === "elsewhere" ? intent.path : "/dashboard/caps";

export const onboardingProgressIndex = (step: OnboardingStep) =>
	step === "welcome" ? 0 : step === "start" ? 1 : 2;

export const ONBOARDING_PROGRESS_TOTAL = 3;

export const splitFullName = (fullName: string) => {
	const [firstName = "", ...rest] = fullName.trim().split(/\s+/);
	return { firstName, lastName: rest.join(" ") };
};

export const maskEmail = (email: string) => {
	const at = email.lastIndexOf("@");
	if (at <= 0) return email;
	const local = email.slice(0, at);
	const visible = local.length > 4 ? 2 : 1;
	const hidden = Math.min(5, Math.max(3, local.length - visible));
	return `${local.slice(0, visible)}${"•".repeat(hidden)}${email.slice(at)}`;
};
