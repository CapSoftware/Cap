import { type ButtonHTMLAttributes, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "@/app/(org)/login/page";
import SignupPage from "@/app/(org)/signup/page";

const mocks = vi.hoisted(() => ({
	getCurrentUser: vi.fn(),
	searchParams: new URLSearchParams(),
	redirect: vi.fn((url: string): never => {
		throw new Error(`redirect:${url}`);
	}),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));
vi.mock("next/navigation", () => ({
	redirect: mocks.redirect,
	useSearchParams: () => mocks.searchParams,
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@cap/ui", () => ({
	Button: ({
		spinner: _spinner,
		...props
	}: ButtonHTMLAttributes<HTMLButtonElement> & { spinner?: boolean }) =>
		createElement("button", { type: "button", ...props }),
	Input: "input",
	LogoBadge: "div",
}));
vi.mock("@/actions/organization/get-organization-sso-data", () => ({
	getOrganizationSSOData: vi.fn(),
}));
vi.mock("@/app/(org)/auth-email", () => ({
	getEmailCodeCooldownSeconds: () => 0,
	requestEmailCode: vi.fn(),
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/utils/public-env", () => ({
	usePublicEnv: () => ({
		googleAuthAvailable: false,
		workosAuthAvailable: true,
	}),
}));
vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));
vi.mock("@/app/(org)/login/form", () => ({
	LoginForm: () => createElement("form", { "aria-label": "Login form" }),
}));
vi.mock("@/app/(org)/signup/form", () => ({
	SignupForm: () => createElement("form", { "aria-label": "Signup form" }),
}));

type Query = Record<string, string | string[]>;

const ssoEntries: [string, Query][] = [
	["organization link", { organizationId: "aaaaaaaaaaaaaaa" }],
	["IdP connection link", { connection_id: "conn_company" }],
	["mobile SSO request", { mobileProvider: "workos" }],
	["work-domain entry", { sso: "1" }],
	["expired intent retry", { error: "SsoSessionExpired" }],
	["failed SSO retry", { error: "SsoSignInFailed" }],
	["missing profile retry", { error: "SsoMissingProfileAttributes" }],
	[
		"unapproved domain retry",
		{ error: "profile_not_allowed_outside_organization" },
	],
	["canceled consent retry", { error: "signin_consent_denied" }],
];

beforeEach(() => {
	mocks.getCurrentUser.mockResolvedValue({ id: "existing-user" });
	mocks.searchParams = new URLSearchParams();
});

describe.each([
	["login", LoginPage, "Login form"],
	["signup", SignupPage, "Signup form"],
] as const)("%s SSO entry", (_name, Page, label) => {
	it.each(ssoEntries)(
		"shows the form to an authenticated user following an %s",
		async (_scenario, query) => {
			const markup = renderToStaticMarkup(
				await Page({ searchParams: Promise.resolve(query) }),
			);
			expect(markup).toContain(`aria-label="${label}"`);
			expect(mocks.redirect).not.toHaveBeenCalled();
		},
	);

	it("uses the first query value consistently with the client form", async () => {
		const markup = renderToStaticMarkup(
			await Page({
				searchParams: Promise.resolve({
					organizationId: ["aaaaaaaaaaaaaaa", ""],
				}),
			}),
		);
		expect(markup).toContain(`aria-label="${label}"`);
		expect(mocks.redirect).not.toHaveBeenCalled();
	});

	it("renders the ordinary authentication form when signed out", async () => {
		mocks.getCurrentUser.mockResolvedValue(null);
		const markup = renderToStaticMarkup(
			await Page({ searchParams: Promise.resolve({}) }),
		);
		expect(markup).toContain(`aria-label="${label}"`);
		expect(mocks.redirect).not.toHaveBeenCalled();
	});

	it.each<Query>([
		{},
		{ error: "OAuthCallback" },
		{ mobileProvider: "google" },
		{ sso: "0" },
		{ organizationId: "", connection_id: "" },
		{ sso: ["0", "1"] },
	])("preserves the normal authenticated redirect for %j", async (query) => {
		await expect(
			Page({ searchParams: Promise.resolve(query) }),
		).rejects.toThrow("redirect:/dashboard");
	});
});

describe("authenticated login continuation", () => {
	it("preserves a safe mobile callback for an ordinary login visit", async () => {
		const continuation =
			"/api/mobile/session/request?redirectUri=cap%3A%2F%2Fauth";
		await expect(
			LoginPage({
				searchParams: Promise.resolve({
					next: `https://cap.test${continuation}`,
				}),
			}),
		).rejects.toThrow(`redirect:${continuation}`);
	});

	it("does not follow an external next URL", async () => {
		await expect(
			LoginPage({
				searchParams: Promise.resolve({ next: "https://other.test/account" }),
			}),
		).rejects.toThrow("redirect:/dashboard");
	});

	it("keeps an SSO retry on the form despite an existing mobile continuation", async () => {
		const markup = renderToStaticMarkup(
			await LoginPage({
				searchParams: Promise.resolve({
					error: "SsoSignInFailed",
					next: "/api/mobile/session/request?redirectUri=cap%3A%2F%2Fauth",
				}),
			}),
		);
		expect(markup).toContain("Login form");
		expect(mocks.redirect).not.toHaveBeenCalled();
	});

	it("keeps the existing ordinary signup redirect unchanged", async () => {
		await expect(
			SignupPage({
				searchParams: Promise.resolve({ next: "/dashboard/caps" }),
			}),
		).rejects.toThrow("redirect:/dashboard");
	});
});

describe.each(["login", "signup"] as const)(
	"%s missing-profile notice",
	(surface) => {
		async function renderForm() {
			const Form =
				surface === "login"
					? (
							await vi.importActual<typeof import("@/app/(org)/login/form")>(
								"@/app/(org)/login/form",
							)
						).LoginForm
					: (
							await vi.importActual<typeof import("@/app/(org)/signup/form")>(
								"@/app/(org)/signup/form",
							)
						).SignupForm;
			return renderToStaticMarkup(createElement(Form));
		}

		it("renders actionable guidance and the SSO form before client effects run", async () => {
			mocks.searchParams.set("error", "SsoMissingProfileAttributes");

			const markup = await renderForm();

			expect(markup).toContain('role="alert"');
			expect(markup).toContain("SSO profile details are missing");
			expect(markup).toContain("first name, and last name");
			expect(markup).toContain("IT administrator");
			expect(markup).toContain("SSO attribute mapping");
			expect(markup).toContain('name="organization"');
			expect(markup).toContain("Continue with SSO");
		});

		it.each(["", "SsoSignInFailed", "<script>untrusted error</script>"])(
			"does not show a missing-profile notice for %j",
			async (error) => {
				mocks.searchParams.set("error", error);

				const markup = await renderForm();

				expect(markup).not.toContain("SSO profile details are missing");
				expect(markup).not.toContain("untrusted error");
			},
		);
	},
);
