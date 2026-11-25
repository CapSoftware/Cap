"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { revalidatePath } from "next/cache";
import {
	type CapFridayRedeemResult,
	type CapFridayState,
	getCapFridayState,
	redeemCapFriday,
} from "@/lib/checkout/cap-friday";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

const FAILED =
	"Something went wrong. Refresh to see where your plan stands, or email hello@cap.so.";

export async function getCapFridayOffer(): Promise<CapFridayState> {
	const user = await getCurrentUser();
	if (!user) return { type: "unavailable", reason: "not_owner" };
	try {
		return await getCapFridayState(user);
	} catch (error) {
		console.error("Failed to price Cap Friday for an existing plan:", error);
		return { type: "unavailable", reason: "custom" };
	}
}

export async function claimCapFriday(input: {
	dueToday: number;
	prorationDate?: number;
}): Promise<CapFridayRedeemResult> {
	const user = await getCurrentUser();
	if (!user) return { ok: false, message: FAILED };
	if (
		!Number.isInteger(input?.dueToday) ||
		(input.prorationDate !== undefined &&
			!Number.isInteger(input.prorationDate))
	) {
		return { ok: false, message: FAILED };
	}
	if (
		await isRateLimited(RATE_LIMIT_IDS.CHECKOUT, {
			key: `checkout:${user.id}`,
		})
	) {
		return {
			ok: false,
			message: "Too many attempts. Wait a few minutes, then try again.",
		};
	}
	try {
		const result = await redeemCapFriday(user, {
			dueToday: input.dueToday,
			prorationDate: input.prorationDate,
		});
		if (result.ok) revalidatePath("/dashboard/settings/organization");
		return result;
	} catch (error) {
		console.error("Cap Friday redemption failed:", error);
		return { ok: false, message: FAILED };
	}
}
