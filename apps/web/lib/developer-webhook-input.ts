import { z } from "zod";
import { WEBHOOK_EVENT_TYPES } from "@/lib/developer-webhook-events";

const endpointFields = {
	url: z.string().min(1).max(2048),
	events: z
		.array(
			z.enum(WEBHOOK_EVENT_TYPES, {
				error: (issue) =>
					`Unknown event${typeof issue.input === "string" ? ` ${JSON.stringify(issue.input.slice(0, 100))}` : ""}. Use ${WEBHOOK_EVENT_TYPES.join(" or ")}.`,
			}),
		)
		.min(1, {
			error: `events must list at least one of: ${WEBHOOK_EVENT_TYPES.join(", ")}`,
		})
		.refine((types) => new Set(types).size === types.length, {
			message: "Each event type can be listed once",
		}),
	enabled: z.boolean(),
};

export const createWebhookEndpointInput = z.strictObject({
	url: endpointFields.url,
	events: endpointFields.events.optional(),
	enabled: endpointFields.enabled.optional(),
});

export const updateWebhookEndpointInput = z
	.strictObject({
		url: endpointFields.url.optional(),
		events: endpointFields.events.optional(),
		enabled: endpointFields.enabled.optional(),
	})
	.refine((fields) => Object.keys(fields).length > 0, {
		message: "Send at least one of url, events or enabled",
	});
