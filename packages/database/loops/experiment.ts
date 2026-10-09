import { createHash } from "node:crypto";

export const freeOnboardingExperiment = "free-pro-v2-2026-09";
export const activationSignalsAfter = new Date("2026-09-12T00:00:00Z");

export function freeOnboardingVariant(userId: string) {
	return createHash("sha256")
		.update(`${freeOnboardingExperiment}:${userId}`)
		.digest()
		.readUInt32BE(0) %
		2 ===
		0
		? "control"
		: "pro-v2";
}

export function inFreeExperiment(signupAt: string, after?: Date) {
	return Boolean(after && Date.parse(signupAt) >= after.getTime());
}
