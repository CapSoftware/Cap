// @vitest-environment jsdom

import {
	act,
	type ButtonHTMLAttributes,
	createElement,
	type ElementType,
	type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	signIn: vi.fn(),
	error: vi.fn(),
	captureException: vi.fn(),
	searchParams: new URLSearchParams(),
}));
vi.mock("next-auth/react", () => ({ signIn: mocks.signIn }));
vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
vi.mock("next/navigation", () => ({
	useSearchParams: () => mocks.searchParams,
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@cap/ui", () => ({
	Button: ({
		spinner: _spinner,
		variant: _variant,
		...props
	}: ButtonHTMLAttributes<HTMLButtonElement> & {
		spinner?: boolean;
		variant?: string;
	}) => createElement("button", { type: "button", ...props }),
	Input: "input",
	LogoBadge: "div",
}));
vi.mock("framer-motion", () => ({
	AnimatePresence: ({ children }: { children: ReactNode }) => children,
	motion: Object.assign((component: ElementType) => component, {
		button: "button",
		div: "div",
		form: "form",
		h1: "h1",
		p: "p",
		span: "span",
	}),
}));
vi.mock("next/image", () => ({ default: "img" }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@fortawesome/react-fontawesome", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("@/actions/organization/get-organization-sso-data", () => ({
	getOrganizationSSOData: vi.fn(),
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/utils/public-env", () => ({
	usePublicEnv: () => ({
		googleAuthAvailable: true,
		workosAuthAvailable: false,
	}),
}));
vi.mock("@/app/(org)/auth-email", () => ({
	getEmailCodeCooldownSeconds: () => 0,
	requestEmailCode: vi.fn(),
}));

const { LoginForm } = await import("@/app/(org)/login/form");
const { SignupForm } = await import("@/app/(org)/signup/form");
let container: HTMLDivElement;
let root: Root;
const actEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeEach(() => {
	actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal("localStorage", {
		getItem: () => null,
		setItem: vi.fn(),
		removeItem: vi.fn(),
	});
	mocks.searchParams = new URLSearchParams();
	mocks.signIn.mockReset().mockResolvedValue(undefined);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
	delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

async function clickGoogle() {
	const button = [...container.querySelectorAll("button")].find((element) =>
		element.textContent?.includes("Google"),
	);
	expect(button).toBeDefined();
	await act(async () => button?.click());
}

describe.each([
	["login", LoginForm],
	["signup", SignupForm],
] as const)("%s OAuth failures", (surface, Form) => {
	it("shows a retry message after a failed request and allows another attempt", async () => {
		mocks.signIn.mockRejectedValueOnce(new TypeError("Load failed"));
		await act(async () => root.render(createElement(Form)));
		await clickGoogle();
		expect(mocks.error).toHaveBeenCalledWith(
			"Could not start sign-in. Check your connection and try again.",
		);
		expect(mocks.captureException).toHaveBeenCalledWith(expect.any(TypeError), {
			tags: { auth_provider: "google", auth_surface: surface },
		});
		await clickGoogle();
		expect(mocks.signIn).toHaveBeenCalledTimes(2);
	});

	it("preserves the callback and does not show an error after success", async () => {
		mocks.searchParams.set("next", "/dashboard/caps");
		await act(async () => root.render(createElement(Form)));
		await clickGoogle();
		expect(mocks.signIn).toHaveBeenCalledWith("google", {
			callbackUrl: "/dashboard/caps",
		});
		expect(mocks.error).not.toHaveBeenCalled();
	});
});

it.each(["apple", "google"])(
	"handles failed automatic mobile %s sign-in without an unhandled rejection",
	async (provider) => {
		mocks.searchParams.set("mobileProvider", provider);
		mocks.signIn.mockRejectedValueOnce(new TypeError("Load failed"));
		await act(async () => root.render(createElement(LoginForm)));
		expect(mocks.signIn).toHaveBeenCalledWith(provider, {});
		expect(mocks.error).toHaveBeenCalledWith(
			"Could not start sign-in. Check your connection and try again.",
		);
	},
);
