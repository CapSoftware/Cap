import "server-only";

import { decrypt, encrypt } from "@cap/database/crypto";
import type { User, Video } from "@cap/web-domain";

type AgentAccessGrantPayload = {
	videoId: string;
	userId: string;
	passwordHash: string;
	expiresAt: string;
};

export const validateAgentAccessGrantPayload = (
	value: unknown,
	videoId: Video.VideoId,
	userId: User.UserId,
	now = Date.now(),
) => {
	if (!value || typeof value !== "object") return null;
	const payload = value as Partial<AgentAccessGrantPayload>;
	if (
		payload.videoId !== videoId ||
		payload.userId !== userId ||
		typeof payload.passwordHash !== "string" ||
		payload.passwordHash.length < 32 ||
		typeof payload.expiresAt !== "string"
	) {
		return null;
	}
	const expiresAt = Date.parse(payload.expiresAt);
	if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
	return {
		passwordHash: payload.passwordHash,
		expiresAt: new Date(expiresAt),
	};
};

export const createAgentAccessGrant = async (
	videoId: Video.VideoId,
	userId: User.UserId,
	passwordHash: string,
) => {
	const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
	const grant = await encrypt(
		JSON.stringify({
			videoId,
			userId,
			passwordHash,
			expiresAt: expiresAt.toISOString(),
		} satisfies AgentAccessGrantPayload),
	);
	return { grant, expiresAt };
};

export const readAgentAccessGrant = async (
	grant: string | undefined,
	videoId: Video.VideoId,
	userId: User.UserId,
) => {
	if (!grant || grant.length > 4_096) return null;
	try {
		return validateAgentAccessGrantPayload(
			JSON.parse(await decrypt(grant)),
			videoId,
			userId,
		);
	} catch {
		return null;
	}
};
