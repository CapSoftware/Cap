import "server-only";

import { canAddFirstPasskeyWithoutCode } from "@cap/database/auth/fresh-sign-in";
import { countPasskeys } from "@cap/database/auth/passkeys";
import { getSession } from "@cap/database/auth/session";
import type { users } from "@cap/database/schema";

export const PASSKEY_PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

type PromptUser = Pick<typeof users.$inferSelect, "id" | "preferences">;

export function passkeyPromptSnoozed(
	preferences: PromptUser["preferences"],
	now = Date.now(),
) {
	const dismissedAt = preferences?.passkeyPromptDismissedAt;
	if (typeof dismissedAt !== "string") return false;
	const dismissed = Date.parse(dismissedAt);
	return (
		Number.isFinite(dismissed) && now - dismissed < PASSKEY_PROMPT_SNOOZE_MS
	);
}

export async function shouldOfferPasskey(user: PromptUser, now = Date.now()) {
	try {
		if (passkeyPromptSnoozed(user.preferences, now)) return false;
		if (!canAddFirstPasskeyWithoutCode(await getSession(), user.id, now))
			return false;
		return (await countPasskeys(user.id)) === 0;
	} catch (error) {
		console.error("[passkeys] Could not decide on the passkey prompt", {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
