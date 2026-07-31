import {
	createProductEventRows,
	normalizeAnalyticsIdentifier,
	normalizeProductEventProperties,
	PRODUCT_ANALYTICS_LIMITS,
	type ProductEventPlatform,
	type ProductEventPropertyField,
	type ServerProductEventName,
} from "@cap/analytics";

type ServerProductEventBase<Name extends ServerProductEventName> = {
	eventId: string;
	eventName: Name;
	occurredAt?: string;
	anonymousId?: string;
	platform: ProductEventPlatform;
	userId?: string;
	organizationId?: string;
	pathname?: string;
};

export type ServerProductEvent<
	Name extends ServerProductEventName = ServerProductEventName,
> = Name extends ServerProductEventName
	? ServerProductEventBase<Name> & ProductEventPropertyField<Name>
	: never;

export function createServerProductEventRows(event: ServerProductEvent) {
	const anonymousId = normalizeServerIdentifier(
		event.anonymousId ?? (event.userId ? `user:${event.userId}` : undefined),
	);
	const eventId = normalizeServerIdentifier(event.eventId);
	if (!anonymousId || !eventId) return [];

	const receivedAt = new Date().toISOString();
	const properties = normalizeProductEventProperties(
		event.eventName,
		event.properties as Record<string, unknown> | undefined,
	);
	if (properties === null) return [];
	return createProductEventRows(
		[
			{
				eventId,
				eventName: event.eventName,
				occurredAt: normalizeServerOccurredAt(event.occurredAt, receivedAt),
				anonymousId,
				platform: event.platform,
				...(event.pathname ? { pathname: event.pathname } : {}),
				...(properties ? { properties } : {}),
			},
		],
		{
			receivedAt,
			source: "server",
			userId: event.userId,
			organizationId: event.organizationId,
		},
	);
}

function normalizeServerOccurredAt(
	value: string | undefined,
	fallback: string,
) {
	if (!value) return fallback;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp)
		? new Date(timestamp).toISOString()
		: fallback;
}

export function normalizeServerIdentifier(value?: string) {
	return normalizeAnalyticsIdentifier(
		value,
		PRODUCT_ANALYTICS_LIMITS.identifierLength,
	);
}
