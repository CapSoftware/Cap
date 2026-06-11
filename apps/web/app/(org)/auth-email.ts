"use client";

import { signIn } from "next-auth/react";
import { toast } from "sonner";
import { trackEvent } from "@/app/utils/analytics";

const emailCodeCooldownMs = 30000;
const emailCodeRequestTimeoutMs = 20000;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type AuthSurface = "login" | "signup";

type RequestEmailCodeOptions = {
	email: string;
	next: string | null;
	isSignup: boolean;
	authSurface: AuthSurface;
};

export function getEmailCodeCooldownSeconds(lastEmailSentTime: number | null) {
	if (!lastEmailSentTime) return 0;

	const remainingMs = emailCodeCooldownMs - (Date.now() - lastEmailSentTime);
	return Math.max(0, Math.ceil(remainingMs / 1000));
}

export async function requestEmailCode({
	email,
	next,
	isSignup,
	authSurface,
}: RequestEmailCodeOptions) {
	const normalizedEmail = email.trim().toLowerCase();

	if (!normalizedEmail || !emailPattern.test(normalizedEmail)) {
		toast.error("Please enter a valid email address.");
		return null;
	}

	trackEvent("auth_started", {
		method: "email",
		is_signup: isSignup,
		auth_surface: authSurface,
	});

	const response = await withTimeout(
		signIn("email", {
			email: normalizedEmail,
			redirect: false,
			...(next && next.length > 0 ? { callbackUrl: next } : {}),
		}),
		emailCodeRequestTimeoutMs,
	);

	if (response?.ok && !response?.error) {
		trackEvent("auth_email_sent", {
			method: "email",
			is_signup: isSignup,
			auth_surface: authSurface,
			email_domain: normalizedEmail.split("@").at(1),
		});

		return normalizedEmail;
	}

	toast.error(
		response?.error === "EmailSignin"
			? "Please wait 30 seconds before requesting a new code."
			: "We could not send a code. Please try again.",
	);

	return null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error("Request timed out"));
		}, timeoutMs);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
