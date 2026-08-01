import type { ProductEventArguments } from "@cap/analytics";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import {
	MobileProductAnalyticsClient,
	type MobileProductEventName,
} from "./product-analytics-client";
import { createMobileProductAnalyticsStorage } from "./product-analytics-storage";

const storage = createMobileProductAnalyticsStorage(
	FileSystem,
	FileSystem.documentDirectory,
);

const client = new MobileProductAnalyticsClient({
	readState: storage.readState,
	writeState: storage.writeState,
	createId: Crypto.randomUUID,
	getAppVersion: () => Constants.expoConfig?.version ?? undefined,
});

const credentialScopeForUserId = (userId: string) =>
	Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, userId);

export const configureMobileProductAnalytics = (input: {
	apiKey: string | null;
	userId: string | null;
	baseUrl: string;
}) =>
	Promise.resolve(
		input.userId ? credentialScopeForUserId(input.userId) : null,
	).then((credentialScope) =>
		client.configure({
			apiKey: input.apiKey,
			credentialScope,
			baseUrl: input.baseUrl,
		}),
	);

export const purgeMobileProductAnalytics = (userId: string) =>
	credentialScopeForUserId(userId).then((credentialScope) =>
		client.purgeCredentialScope(credentialScope),
	);

export const flushMobileProductAnalytics = () => client.flush();

export const createMobileProductAnalyticsEventId = () => Crypto.randomUUID();

export const trackMobileProductEvent = <Name extends MobileProductEventName>(
	eventName: Name,
	...args: ProductEventArguments<Name>
) => client.track(eventName, ...args);

export const trackMobileProductEventWithId = <
	Name extends MobileProductEventName,
>(
	eventId: string,
	occurredAt: string,
	eventName: Name,
	...args: ProductEventArguments<Name>
) => client.trackWithId(eventId, occurredAt, eventName, ...args);

export const getMobileProductAnalyticsHealth = () => client.snapshot();

export const classifyMobileAnalyticsFailure = (error: unknown) => {
	const value = error instanceof Error ? error.message.toLowerCase() : "";
	if (value.includes("timeout") || value.includes("timed out"))
		return "timeout";
	if (value.includes("permission") || value.includes("denied")) {
		return "permission";
	}
	if (value.includes("network") || value.includes("connect")) return "network";
	if (value.includes("storage") || value.includes("disk")) return "storage";
	if (value.includes("format") || value.includes("media"))
		return "invalid_media";
	return "unknown";
};
