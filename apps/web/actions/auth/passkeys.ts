"use server";

import {
	hasStepUpGrant,
	issueStepUpCode,
	issueStepUpGrant,
	verifyStepUpCode,
} from "@cap/database/auth/auth-challenges";
import {
	createPasskeyRegistrationOptions,
	createPasskeySignInOptions,
	createPasskeyStepUpOptions,
	deletePasskey,
	listPasskeys,
	verifyPasskeyRegistration,
	verifyPasskeyStepUp,
} from "@cap/database/auth/passkeys";
import {
	sendAccountSecurityCode,
	sendPasskeyAddedNotice,
} from "@cap/database/auth/security-emails";
import { getCurrentUser } from "@cap/database/auth/session";
import type {
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export type PasskeyListItem = {
	id: string;
	name: string;
	createdAt: string;
	lastUsedAt: string | null;
	backedUp: boolean;
};

async function requireUser() {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	return user;
}

export async function getPasskeySignInOptions(): Promise<
	| { status: "ok"; options: PublicKeyCredentialRequestOptionsJSON }
	| { status: "rate_limited" }
> {
	if (await isRateLimited(RATE_LIMIT_IDS.AUTH_PASSKEY)) {
		return { status: "rate_limited" };
	}
	return { status: "ok", options: await createPasskeySignInOptions() };
}

export async function sendSecurityCode(): Promise<
	| { status: "sent" }
	| { status: "cooldown"; retryAfterSeconds: number }
	| { status: "rate_limited" }
> {
	const user = await requireUser();
	if (
		await isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_SEND, {
			key: `security-code-send:${user.id}`,
		})
	) {
		return { status: "rate_limited" };
	}
	const issued = await issueStepUpCode(user.id);
	if (issued.status === "cooldown") return issued;
	await sendAccountSecurityCode(user.email, issued.code);
	return { status: "sent" };
}

export async function verifySecurityCode(
	code: string,
): Promise<
	{ status: "ok"; grant: string } | { status: "invalid" | "rate_limited" }
> {
	const user = await requireUser();
	if (
		await isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_VERIFY, {
			key: `security-code-verify:${user.id}`,
		})
	) {
		return { status: "rate_limited" };
	}
	if (typeof code !== "string" || !(await verifyStepUpCode(user.id, code))) {
		return { status: "invalid" };
	}
	return { status: "ok", grant: await issueStepUpGrant(user.id) };
}

export async function getPasskeyStepUpOptions(): Promise<
	| { status: "ok"; options: PublicKeyCredentialRequestOptionsJSON }
	| { status: "none" | "rate_limited" }
> {
	const user = await requireUser();
	if (await isRateLimited(RATE_LIMIT_IDS.AUTH_PASSKEY)) {
		return { status: "rate_limited" };
	}
	const options = await createPasskeyStepUpOptions(user.id);
	return options ? { status: "ok", options } : { status: "none" };
}

export async function verifyPasskeyForStepUp(
	response: string,
): Promise<{ status: "ok"; grant: string } | { status: "invalid" }> {
	const user = await requireUser();
	if (!(await verifyPasskeyStepUp(user.id, response))) {
		return { status: "invalid" };
	}
	return { status: "ok", grant: await issueStepUpGrant(user.id) };
}

export async function getPasskeyRegistrationOptions(
	grant: string,
): Promise<
	| { status: "ok"; options: PublicKeyCredentialCreationOptionsJSON }
	| { status: "verify" | "limit" }
> {
	const user = await requireUser();
	if (!(await hasStepUpGrant(user.id, grant))) return { status: "verify" };
	const options = await createPasskeyRegistrationOptions(user);
	return options ? { status: "ok", options } : { status: "limit" };
}

export async function completePasskeyRegistration(
	response: string,
): Promise<
	| { status: "registered"; passkey: PasskeyListItem }
	| { status: "invalid" | "duplicate" | "limit" }
> {
	const user = await requireUser();
	const result = await verifyPasskeyRegistration(user.id, response);
	if (result.status !== "registered") return { status: result.status };
	await sendPasskeyAddedNotice(user.email, result.passkey.name);
	return {
		status: "registered",
		passkey: {
			...result.passkey,
			createdAt: result.passkey.createdAt.toISOString(),
			lastUsedAt: null,
		},
	};
}

export async function listMyPasskeys(): Promise<PasskeyListItem[]> {
	const user = await requireUser();
	const passkeys = await listPasskeys(user.id);
	return passkeys.map((passkey) => ({
		...passkey,
		createdAt: passkey.createdAt.toISOString(),
		lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
	}));
}

export async function removePasskey(passkeyId: string) {
	const user = await requireUser();
	return { removed: await deletePasskey(user.id, passkeyId) };
}
