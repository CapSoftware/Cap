import { Hono } from "hono";
import { apiErrorBody } from "@/lib/api-errors";
import { parseDeveloperListQuery } from "@/lib/developer-pagination";
import {
	createWebhookEndpointInput,
	updateWebhookEndpointInput,
} from "@/lib/developer-webhook-input";
import {
	createWebhookEndpoint,
	deleteWebhookEndpoint,
	getWebhookEndpoint,
	listWebhookEndpoints,
	rotateWebhookEndpointSecret,
	sendWebhookTestEvent,
	serializeWebhookEndpoint,
	serializeWebhookTestResult,
	updateWebhookEndpoint,
	type WebhookFailure,
} from "@/lib/developer-webhooks";
import { developerZValidator } from "@/utils/zod-validator";
import { withDeveloperSecretAuth } from "../../../utils";

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "secret";
	};
}>().use(withDeveloperSecretAuth);

const failureBody = (failure: WebhookFailure) =>
	apiErrorBody(failure.code, failure.message, failure.hint);

app.post(
	"/",
	developerZValidator("json", createWebhookEndpointInput),
	async (c) => {
		const result = await createWebhookEndpoint(
			c.get("developerAppId"),
			c.req.valid("json"),
		);
		if (!result.ok) return c.json(failureBody(result), result.status);
		return c.json({
			data: {
				...serializeWebhookEndpoint(result.endpoint),
				secret: result.secret,
			},
		});
	},
);

app.get("/", async (c) => {
	const parsed = parseDeveloperListQuery(c.req.query(), []);
	if (!parsed.ok) {
		return c.json(apiErrorBody(parsed.code, parsed.message, parsed.hint), 400);
	}
	const { limit, offset } = parsed;
	const { endpoints, hasMore } = await listWebhookEndpoints(
		c.get("developerAppId"),
		{ limit, offset },
	);
	return c.json({
		data: endpoints.map(serializeWebhookEndpoint),
		pagination: { limit, offset, hasMore },
	});
});

app.get("/:id", async (c) => {
	const endpoint = await getWebhookEndpoint(
		c.get("developerAppId"),
		c.req.param("id"),
	);
	if (!endpoint) {
		return c.json(
			apiErrorBody(
				"webhook_not_found",
				"Webhook endpoint not found",
				"Check the endpoint ID and that it belongs to this app. Deleted endpoints are not returned.",
			),
			404,
		);
	}
	return c.json({ data: serializeWebhookEndpoint(endpoint) });
});

app.patch(
	"/:id",
	developerZValidator("json", updateWebhookEndpointInput),
	async (c) => {
		const result = await updateWebhookEndpoint(
			c.get("developerAppId"),
			c.req.param("id"),
			c.req.valid("json"),
		);
		if (!result.ok) return c.json(failureBody(result), result.status);
		return c.json({ data: serializeWebhookEndpoint(result.endpoint) });
	},
);

app.delete("/:id", async (c) => {
	const result = await deleteWebhookEndpoint(
		c.get("developerAppId"),
		c.req.param("id"),
	);
	if (!result.ok) return c.json(failureBody(result), result.status);
	return c.json({ success: true });
});

app.post("/:id/rotate-secret", async (c) => {
	const result = await rotateWebhookEndpointSecret(
		c.get("developerAppId"),
		c.req.param("id"),
	);
	if (!result.ok) return c.json(failureBody(result), result.status);
	return c.json({
		data: {
			...serializeWebhookEndpoint(result.endpoint),
			secret: result.secret,
		},
	});
});

app.post("/:id/test", async (c) => {
	const result = await sendWebhookTestEvent(
		c.get("developerAppId"),
		c.req.param("id"),
	);
	if (!result.ok) return c.json(failureBody(result), result.status);
	return c.json({
		data: serializeWebhookTestResult(result.eventId, result.result),
	});
});
