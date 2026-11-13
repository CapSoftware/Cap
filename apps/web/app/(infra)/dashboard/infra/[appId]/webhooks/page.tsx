import {
	MAX_WEBHOOK_ENDPOINTS_PER_APP,
	WEBHOOK_DISABLED_BY_FAILURES,
	WEBHOOK_EVENT_TYPES,
} from "@/lib/developer-webhook-events";
import {
	listWebhookEndpoints,
	serializeWebhookEndpoint,
} from "@/lib/developer-webhooks";
import { infraPageMetadata, requireInfraApp } from "../../infra-data";
import { WebhooksClient } from "./webhooks-client";

export const generateMetadata = infraPageMetadata("Webhooks");

export default async function InfraWebhooksPage({
	params,
}: {
	params: Promise<{ appId: string }>;
}) {
	const { appId } = await params;
	const { app } = await requireInfraApp(appId);
	const { endpoints } = await listWebhookEndpoints(app.id, {
		limit: MAX_WEBHOOK_ENDPOINTS_PER_APP,
		offset: 0,
	});

	return (
		<WebhooksClient
			appId={app.id}
			limit={MAX_WEBHOOK_ENDPOINTS_PER_APP}
			eventTypes={WEBHOOK_EVENT_TYPES}
			endpoints={endpoints.map((row) => {
				const endpoint = serializeWebhookEndpoint(row);
				return {
					id: endpoint.id,
					url: endpoint.url,
					events: endpoint.events,
					enabled: endpoint.enabled,
					disabledByFailures:
						endpoint.disabledReason === WEBHOOK_DISABLED_BY_FAILURES,
					secretPrefix: endpoint.secretPrefix,
					lastDeliveryAt: endpoint.lastDeliveryAt,
					lastDeliveryStatus: endpoint.lastDeliveryStatus,
					lastResponseStatus: endpoint.lastResponseStatus,
					lastErrorCode: endpoint.lastErrorCode,
					consecutiveFailures: endpoint.consecutiveFailures,
				};
			})}
		/>
	);
}
