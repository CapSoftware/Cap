// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	signIn: vi.fn(),
	getSession: vi.fn(async () => ({ user: { id: "user" } }) as unknown),
	trackEvent: vi.fn(),
	captureException: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
	signIn: mocks.signIn,
	getSession: mocks.getSession,
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: mocks.trackEvent }));
vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

import {
	googleCredentialLoginHint,
	signInWithGoogleOneTap,
	useGoogleOneTap,
} from "@/app/(org)/google-one-tap";

function fakeCredential(claims: Record<string, unknown>) {
	const encode = (value: unknown) =>
		btoa(JSON.stringify(value))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

type InitializeConfig = {
	callback: (response: { credential?: unknown }) => void;
	[key: string]: unknown;
};

function stubGoogle() {
	const accountsId = {
		initialize: vi.fn<(config: InitializeConfig) => void>(),
		prompt: vi.fn(),
		cancel: vi.fn(),
	};
	Object.assign(window, { google: { accounts: { id: accountsId } } });
	return accountsId;
}

function stubNonce(nonce = "nonce-from-server-0123456789") {
	const fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify({ nonce }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let cancelRef: (() => void) | null = null;

function OneTap(props: {
	enabled: boolean;
	clientId?: string | null;
	onCredential: (credential: string) => void;
}) {
	cancelRef = useGoogleOneTap({
		clientId: props.clientId === undefined ? "client-id" : props.clientId,
		enabled: props.enabled,
		context: "signin",
		onCredential: props.onCredential,
	});
	return null;
}

async function render(props: Parameters<typeof OneTap>[0]) {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(createElement(OneTap, props));
	});
}

async function flush() {
	await act(async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	});
}

beforeEach(() => {
	mocks.signIn.mockReset();
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	cancelRef = null;
	Reflect.deleteProperty(window, "google");
	for (const script of document.head.querySelectorAll("script"))
		script.remove();
	vi.unstubAllGlobals();
});

describe("useGoogleOneTap", () => {
	it("initializes One Tap with the server nonce and FedCM settings, then prompts", async () => {
		const accountsId = stubGoogle();
		const { fetchMock } = stubNonce();
		await render({ enabled: true, onCredential: vi.fn() });
		await flush();

		expect(fetchMock).toHaveBeenCalledWith("/api/auth/google-one-tap", {
			method: "POST",
			credentials: "same-origin",
			cache: "no-store",
		});
		expect(accountsId.initialize).toHaveBeenCalledTimes(1);
		expect(accountsId.initialize.mock.calls[0]?.[0]).toMatchObject({
			client_id: "client-id",
			nonce: "nonce-from-server-0123456789",
			use_fedcm_for_prompt: true,
			itp_support: true,
			auto_select: false,
			cancel_on_tap_outside: true,
			context: "signin",
		});
		expect(accountsId.initialize.mock.calls[0]?.[0]).not.toHaveProperty(
			"ux_mode",
		);
		expect(accountsId.prompt).toHaveBeenCalledTimes(1);
	});

	it("passes the credential to the page once and cancels on unmount", async () => {
		const accountsId = stubGoogle();
		stubNonce();
		const onCredential = vi.fn();
		await render({ enabled: true, onCredential });
		await flush();

		const config = accountsId.initialize.mock.calls[0]?.[0];
		config?.callback({ credential: "header.payload.sig" });
		config?.callback({ credential: "header.payload.sig" });
		expect(onCredential).toHaveBeenCalledTimes(1);
		expect(onCredential).toHaveBeenCalledWith("header.payload.sig");

		await act(async () => root?.unmount());
		root = null;
		expect(accountsId.cancel).not.toHaveBeenCalled();
	});

	it("cancels the prompt when the page unmounts while it is open", async () => {
		const accountsId = stubGoogle();
		stubNonce();
		await render({ enabled: true, onCredential: vi.fn() });
		await flush();
		await act(async () => root?.unmount());
		root = null;
		expect(accountsId.cancel).toHaveBeenCalledTimes(1);
	});

	it("cancels the prompt when another sign-in method starts", async () => {
		const accountsId = stubGoogle();
		stubNonce();
		const onCredential = vi.fn();
		await render({ enabled: true, onCredential });
		await flush();

		cancelRef?.();
		expect(accountsId.cancel).toHaveBeenCalledTimes(1);
		accountsId.initialize.mock.calls[0]?.[0]?.callback({
			credential: "late.credential.sig",
		});
		expect(onCredential).not.toHaveBeenCalled();
	});

	it("never prompts when another method started before the nonce arrived", async () => {
		const accountsId = stubGoogle();
		const response = Promise.withResolvers<Response>();
		vi.stubGlobal(
			"fetch",
			vi.fn(() => response.promise),
		);
		await render({ enabled: true, onCredential: vi.fn() });
		cancelRef?.();
		await act(async () => {
			response.resolve(
				new Response(JSON.stringify({ nonce: "late-nonce-0123456789abc" })),
			);
			await response.promise;
		});
		await flush();
		expect(accountsId.initialize).not.toHaveBeenCalled();
		expect(accountsId.prompt).not.toHaveBeenCalled();
	});

	it("does nothing when disabled or without a client id", async () => {
		const accountsId = stubGoogle();
		const { fetchMock } = stubNonce();
		await render({ enabled: false, onCredential: vi.fn() });
		await flush();
		await act(async () => root?.unmount());
		await render({ enabled: true, clientId: null, onCredential: vi.fn() });
		await flush();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(accountsId.initialize).not.toHaveBeenCalled();
		expect(document.head.querySelector("script")).toBeNull();
	});

	it("stays silent when the Google script fails to load", async () => {
		stubNonce();
		const errors = vi.spyOn(console, "error");
		await render({ enabled: true, onCredential: vi.fn() });
		await flush();

		const script = document.head.querySelector<HTMLScriptElement>(
			'script[src="https://accounts.google.com/gsi/client"]',
		);
		expect(script?.async).toBe(true);
		await act(async () => {
			script?.dispatchEvent(new Event("error"));
		});
		await flush();
		expect(document.head.querySelector("script")).toBeNull();
		expect(errors).not.toHaveBeenCalled();
	});

	it("stays silent when the nonce request fails", async () => {
		const accountsId = stubGoogle();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("Failed to fetch");
			}),
		);
		await render({ enabled: true, onCredential: vi.fn() });
		await flush();
		expect(accountsId.initialize).not.toHaveBeenCalled();
		expect(accountsId.prompt).not.toHaveBeenCalled();
	});
});

describe("signInWithGoogleOneTap", () => {
	const credential = fakeCredential({ email: "alex@example.com" });

	it("signs in a linked account through the One Tap provider", async () => {
		const assign = vi.fn();
		vi.stubGlobal("location", { ...window.location, assign });
		mocks.signIn.mockResolvedValueOnce({
			ok: true,
			error: null,
			status: 200,
			url: "https://cap.so/dashboard/caps",
		});
		await signInWithGoogleOneTap({
			credential,
			nextPath: "/dashboard/caps",
			isSignup: false,
			authSurface: "login",
		});
		expect(mocks.signIn).toHaveBeenCalledTimes(1);
		expect(mocks.signIn).toHaveBeenCalledWith("google-one-tap", {
			credential,
			callbackUrl: "/dashboard/caps",
			redirect: false,
		});
		expect(assign).toHaveBeenCalledWith("/dashboard/caps");
		expect(mocks.trackEvent).toHaveBeenCalledWith("auth_started", {
			method: "google_one_tap",
			is_signup: false,
			auth_surface: "login",
		});
	});

	it("does not navigate when NextAuth reports success but no session exists", async () => {
		const assign = vi.fn();
		vi.stubGlobal("location", { ...window.location, assign });
		mocks.getSession.mockResolvedValueOnce(null);
		mocks.signIn
			.mockResolvedValueOnce({
				ok: true,
				error: null,
				status: 200,
				url: "https://cap.so/api/auth/signin?csrf=true",
			})
			.mockResolvedValueOnce(undefined);
		await signInWithGoogleOneTap({
			credential,
			nextPath: "/dashboard/caps",
			isSignup: false,
			authSurface: "login",
		});
		expect(assign).not.toHaveBeenCalled();
		expect(mocks.signIn).toHaveBeenLastCalledWith(
			"google",
			{ callbackUrl: "/dashboard/caps" },
			expect.anything(),
		);
	});

	it("falls back to the Google redirect flow with a login hint", async () => {
		mocks.signIn
			.mockResolvedValueOnce({
				ok: false,
				error: "CredentialsSignin",
				status: 401,
				url: null,
			})
			.mockResolvedValueOnce(undefined);
		await signInWithGoogleOneTap({
			credential,
			nextPath: "/dashboard/caps",
			isSignup: true,
			authSurface: "signup",
		});
		expect(mocks.signIn).toHaveBeenLastCalledWith(
			"google",
			{ callbackUrl: "/dashboard/caps" },
			{ login_hint: "alex@example.com" },
		);
	});

	it("keeps the existing redirect defaults when there is no next path", async () => {
		mocks.signIn
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValueOnce(undefined);
		await signInWithGoogleOneTap({
			credential: "not-a-jwt",
			nextPath: null,
			isSignup: false,
			authSurface: "login",
		});
		expect(mocks.signIn).toHaveBeenNthCalledWith(1, "google-one-tap", {
			credential: "not-a-jwt",
			callbackUrl: "/dashboard",
			redirect: false,
		});
		expect(mocks.signIn).toHaveBeenLastCalledWith("google", {}, undefined);
	});

	it("reports a fallback that cannot start", async () => {
		mocks.signIn
			.mockResolvedValueOnce({ ok: false, error: "CredentialsSignin" })
			.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		await signInWithGoogleOneTap({
			credential,
			nextPath: null,
			isSignup: false,
			authSurface: "login",
		});
		expect(mocks.captureException).toHaveBeenCalledTimes(1);
		expect(mocks.toastError).toHaveBeenCalledTimes(1);
	});
});

describe("googleCredentialLoginHint", () => {
	it("reads the email claim without trusting anything else", () => {
		expect(
			googleCredentialLoginHint(fakeCredential({ email: "a@b.example" })),
		).toBe("a@b.example");
		expect(googleCredentialLoginHint(fakeCredential({ email: 42 }))).toBeNull();
		expect(
			googleCredentialLoginHint(
				fakeCredential({ email: `${"a".repeat(320)}@b.example` }),
			),
		).toBeNull();
		expect(googleCredentialLoginHint("garbage")).toBeNull();
	});
});
