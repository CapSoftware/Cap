import {
	createProductEventRows,
	getProductEventDefinition,
	normalizeAnalyticsOpaqueIdentifier,
	normalizeProductEventProperties,
	PRODUCT_ANALYTICS_LIMITS,
	type ProductEventPlatformFor,
	type ProductEventPropertyField,
	type ServerProductEventName,
} from "@cap/analytics";

type ServerProductEventBase<Name extends ServerProductEventName> = {
	_syntheticRunId?: string;
	eventId: string;
	eventName: Name;
	occurredAt: string;
	anonymousId?: string;
	platform: ProductEventPlatformFor<Name>;
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
	const userId = normalizeServerIdentifier(event.userId);
	const organizationId = normalizeServerIdentifier(event.organizationId);
	if (
		(event.userId !== undefined && !userId) ||
		(event.organizationId !== undefined && !organizationId)
	) {
		return [];
	}
	const anonymousId = normalizeServerIdentifier(
		event.anonymousId ?? (userId ? `user:${userId}` : undefined),
	);
	const eventId = normalizeServerIdentifier(event.eventId);
	const syntheticRunId = normalizeServerIdentifier(event._syntheticRunId);
	const occurredAt = normalizeServerOccurredAt(event.occurredAt);
	if (
		!anonymousId ||
		!eventId ||
		!occurredAt ||
		(event._syntheticRunId !== undefined && !syntheticRunId)
	) {
		return [];
	}

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
				occurredAt,
				anonymousId,
				schemaVersion: getProductEventDefinition(event.eventName).version,
				platform: event.platform,
				...(event.pathname ? { pathname: event.pathname } : {}),
				...(properties ? { properties } : {}),
			},
		],
		{
			receivedAt,
			source: "server",
			userId,
			organizationId,
			...(syntheticRunId
				? { syntheticRunId, trafficClass: "synthetic" as const }
				: {}),
		},
	);
}

function normalizeServerOccurredAt(value: string) {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp)
		? new Date(timestamp).toISOString()
		: undefined;
}

export function normalizeServerIdentifier(value?: string) {
	return normalizeAnalyticsOpaqueIdentifier(
		value,
		PRODUCT_ANALYTICS_LIMITS.identifierLength,
	);
}
