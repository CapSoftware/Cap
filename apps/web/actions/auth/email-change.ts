"use server";

import { hasStepUpGrant } from "@cap/database/auth/auth-challenges";
import { normalizeSignInEmail } from "@cap/database/auth/domain-utils";
import {
	confirmEmailChange,
	pendingEmailChangeAddress,
	requestEmailChange,
} from "@cap/database/auth/email-change";
import {
	sendEmailChangeCode,
	sendEmailChangedNotice,
} from "@cap/database/auth/security-emails";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	isEmailChangeSendLimited,
	isEmailChangeVerifyLimited,
} from "@/lib/email-code-rate-limit";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export type StartEmailChangeResult =
	| { status: "sent"; email: string }
	| { status: "cooldown"; retryAfterSeconds: number }
	| {
			status:
				| "verify"
				| "invalid"
				| "same"
				| "not_allowed"
				| "managed"
				| "rate_limited";
	  };

export type FinishEmailChangeResult =
	| { status: "changed"; email: string }
	| {
			status:
				| "invalid"
				| "taken"
				| "not_allowed"
				| "managed"
				| "failed"
				| "rate_limited";
	  };

export async function startEmailChange(
	grant: string,
	newEmail: string,
): Promise<StartEmailChangeResult> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	if (!(await hasStepUpGrant(user.id, grant))) return { status: "verify" };
	if (
		await isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_SEND, {
			key: `email-change-send:${user.id}`,
		})
	) {
		return { status: "rate_limited" };
	}
	const target = normalizeSignInEmail(newEmail);
	if (target && (await isEmailChangeSendLimited(target))) {
		return { status: "rate_limited" };
	}
	const result = await requestEmailChange(user, newEmail);
	if (result.status !== "issued") return result;
	await sendEmailChangeCode(result.email, result.code);
	return { status: "sent", email: result.email };
}

export async function finishEmailChange(
	code: string,
): Promise<FinishEmailChangeResult> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	if (
		await isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_VERIFY, {
			key: `email-change-verify:${user.id}`,
		})
	) {
		return { status: "rate_limited" };
	}
	const pendingAddress = await pendingEmailChangeAddress(user.id);
	if (pendingAddress && (await isEmailChangeVerifyLimited(pendingAddress))) {
		return { status: "rate_limited" };
	}
	const result = await confirmEmailChange(user.id, code);
	if (result.status !== "changed") return result;
	await sendEmailChangedNotice(result.previousEmail, result.email);
	return { status: "changed", email: result.email };
}
