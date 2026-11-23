"use client";

import { captureException } from "@sentry/nextjs";
import { getSession, signIn } from "next-auth/react";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { trackEvent } from "@/app/utils/analytics";

const GOOGLE_IDENTITY_SCRIPT_SRC = "https://accounts.google.com/gsi/client";
const GOOGLE_ONE_TAP_NONCE_PATH = "/api/auth/google-one-tap";
const MAX_LOGIN_HINT_LENGTH = 320;

type GoogleCredentialResponse = { credential?: unknown };

type GoogleAccountsId = {
	initialize: (config: {
		client_id: string;
		nonce: string;
		callback: (response: GoogleCredentialResponse) => void;
		use_fedcm_for_prompt: boolean;
		itp_support: boolean;
		auto_select: boolean;
		cancel_on_tap_outside: boolean;
		context: "signin" | "signup";
	}) => void;
	prompt: () => void;
	cancel: () => void;
};

type WindowWithGoogle = Window & {
	google?: { accounts?: { id?: GoogleAccountsId } };
};

let googleIdentityScript: Promise<GoogleAccountsId | null> | null = null;

function currentGoogleAccountsId() {
	return (window as WindowWithGoogle).google?.accounts?.id ?? null;
}

function loadGoogleIdentity(): Promise<GoogleAccountsId | null> {
	const loaded = currentGoogleAccountsId();
	if (loaded) return Promise.resolve(loaded);
	googleIdentityScript ??= new Promise((resolve) => {
		const script = document.createElement("script");
		script.src = GOOGLE_IDENTITY_SCRIPT_SRC;
		script.async = true;
		script.onload = () => resolve(currentGoogleAccountsId());
		script.onerror = () => {
			googleIdentityScript = null;
			script.remove();
			resolve(null);
		};
		document.head.appendChild(script);
	});
	return googleIdentityScript;
}

let googleOneTapNonceRequest: Promise<string | null> | null = null;

function requestGoogleOneTapNonce(): Promise<string | null> {
	googleOneTapNonceRequest ??= fetchGoogleOneTapNonce().finally(() => {
		googleOneTapNonceRequest = null;
	});
	return googleOneTapNonceRequest;
}

async function fetchGoogleOneTapNonce(): Promise<string | null> {
	const response = await fetch(GOOGLE_ONE_TAP_NONCE_PATH, {
		method: "POST",
		credentials: "same-origin",
		cache: "no-store",
	});
	if (!response.ok) return null;
	const body: unknown = await response.json();
	if (!body || typeof body !== "object") return null;
	const nonce = (body as { nonce?: unknown }).nonce;
	return typeof nonce === "string" && nonce ? nonce : null;
}

export function googleCredentialLoginHint(credential: string): string | null {
	try {
		const payload = credential.split(".")[1];
		if (!payload) return null;
		const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const binary = atob(base64);
		const claims: unknown = JSON.parse(
			new TextDecoder().decode(
				Uint8Array.from(binary, (character) => character.charCodeAt(0)),
			),
		);
		if (!claims || typeof claims !== "object") return null;
		const email = (claims as { email?: unknown }).email;
		if (typeof email !== "string" || !email.includes("@")) return null;
		return email.length > MAX_LOGIN_HINT_LENGTH ? null : email;
	} catch {
		return null;
	}
}

export async function signInWithGoogleOneTap(input: {
	credential: string;
	nextPath: string | null;
	isSignup: boolean;
	authSurface: "login" | "signup";
}) {
	const { credential, nextPath, isSignup, authSurface } = input;
	const callbackUrl = nextPath ?? "/dashboard";
	trackEvent("auth_started", {
		method: "google_one_tap",
		is_signup: isSignup,
		auth_surface: authSurface,
	});
	try {
		const result = await signIn("google-one-tap", {
			credential,
			callbackUrl,
			redirect: false,
		});
		if (result?.ok && !result.error && (await getSession())?.user) {
			window.location.assign(callbackUrl);
			return;
		}
	} catch {}

	const loginHint = googleCredentialLoginHint(credential);
	await signIn(
		"google",
		{ ...(nextPath ? { callbackUrl: nextPath } : {}) },
		loginHint ? { login_hint: loginHint } : undefined,
	).catch((error) => {
		captureException(error, {
			tags: { auth_provider: "google_one_tap", auth_surface: authSurface },
		});
		toast.error(
			"Could not start sign-in. Check your connection and try again.",
		);
	});
}

export function useGoogleOneTap(input: {
	clientId: string | null | undefined;
	enabled: boolean;
	context: "signin" | "signup";
	onCredential: (credential: string) => void;
}) {
	const { clientId, enabled, context } = input;
	const onCredential = useRef(input.onCredential);
	onCredential.current = input.onCredential;
	const dismissed = useRef(false);
	const prompting = useRef(false);

	const cancel = useCallback(() => {
		dismissed.current = true;
		if (!prompting.current) return;
		prompting.current = false;
		try {
			currentGoogleAccountsId()?.cancel();
		} catch {}
	}, []);

	useEffect(() => {
		if (!enabled || !clientId || dismissed.current) return;
		let disposed = false;
		const start = async () => {
			try {
				const [nonce, accountsId] = await Promise.all([
					requestGoogleOneTapNonce(),
					loadGoogleIdentity(),
				]);
				if (disposed || dismissed.current || !nonce || !accountsId) return;
				accountsId.initialize({
					client_id: clientId,
					nonce,
					callback: (response) => {
						if (!prompting.current) return;
						prompting.current = false;
						dismissed.current = true;
						if (typeof response?.credential === "string") {
							onCredential.current(response.credential);
						}
					},
					use_fedcm_for_prompt: true,
					itp_support: true,
					auto_select: false,
					cancel_on_tap_outside: true,
					context,
				});
				prompting.current = true;
				accountsId.prompt();
			} catch {
				prompting.current = false;
			}
		};
		void start();
		return () => {
			disposed = true;
			if (!prompting.current) return;
			prompting.current = false;
			try {
				currentGoogleAccountsId()?.cancel();
			} catch {}
		};
	}, [clientId, context, enabled]);

	return cancel;
}
