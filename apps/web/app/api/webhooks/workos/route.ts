import { db } from "@cap/database";
import { getWorkOS } from "@cap/database/auth/sso";
import { organizations } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Organisation } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option } from "effect";
import { apiToHandler } from "@/lib/server";
import { requestDirectorySync } from "@/lib/sso/directory-sync";
import { verifyWorkosSignature } from "@/lib/sso/workos-webhook";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_000_000;

class Api extends HttpApi.make("WorkosWebhookApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("receiveWorkosEvent")`/api/webhooks/workos`,
	),
) {}

const textResponse = (body: string, status: number) =>
	HttpServerResponse.text(body, {
		status,
		headers: { "Cache-Control": "private, no-store" },
	});

const received = () =>
	HttpServerResponse.text(JSON.stringify({ received: true }), {
		status: 200,
		contentType: "application/json; charset=utf-8",
		headers: { "Cache-Control": "private, no-store" },
	});

function eventOrganization(data: unknown) {
	if (!data || typeof data !== "object") return null;
	const record = data as Record<string, unknown>;
	if (typeof record.organization_id === "string") return record.organization_id;
	const user = record.user;
	if (
		user &&
		typeof user === "object" &&
		typeof (user as Record<string, unknown>).organization_id === "string"
	) {
		return (user as Record<string, string>).organization_id;
	}
	return null;
}

function eventDirectory(data: unknown) {
	if (!data || typeof data !== "object") return null;
	const record = data as Record<string, unknown>;
	if (typeof record.directory_id === "string") return record.directory_id;
	if (record.object === "directory" && typeof record.id === "string")
		return record.id;
	return null;
}

async function findOrganization(data: unknown) {
	let workosOrganizationId = eventOrganization(data);
	if (!workosOrganizationId) {
		const directoryId = eventDirectory(data);
		if (directoryId) {
			const directory = await getWorkOS()
				.directorySync.getDirectory(directoryId)
				.catch(() => null);
			workosOrganizationId = directory?.organizationId ?? null;
		}
	}
	if (!workosOrganizationId) return null;
	const [organization] = await db()
		.select({ id: organizations.id })
		.from(organizations)
		.where(eq(organizations.workosOrganizationId, workosOrganizationId))
		.limit(1);
	return organization
		? Organisation.OrganisationId.make(organization.id)
		: null;
}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("receiveWorkosEvent", () =>
				Effect.gen(function* () {
					const secret = serverEnv().WORKOS_WEBHOOK_SECRET;
					if (!secret) return textResponse("Not configured", 503);
					const request = yield* HttpServerRequest.HttpServerRequest;
					const payload = yield* request.text.pipe(
						HttpServerRequest.withMaxBodySize(Option.some(MAX_BODY_BYTES)),
						Effect.catchAll(() => Effect.succeed("")),
					);
					if (
						!verifyWorkosSignature(
							payload,
							request.headers["workos-signature"] ?? null,
							secret,
						)
					) {
						return textResponse("Invalid signature", 400);
					}
					let event: { event?: unknown; data?: unknown };
					try {
						event = JSON.parse(payload);
					} catch {
						return textResponse("Invalid payload", 400);
					}
					if (
						typeof event.event !== "string" ||
						!event.event.startsWith("dsync.")
					) {
						return received();
					}
					const organizationId = yield* Effect.tryPromise(() =>
						findOrganization(event.data),
					).pipe(Effect.orElseSucceed(() => undefined));
					if (organizationId === undefined)
						return textResponse("Lookup failed", 500);
					if (!organizationId) return received();
					const requested = yield* Effect.tryPromise(() =>
						requestDirectorySync(organizationId),
					).pipe(
						Effect.as(true),
						Effect.orElseSucceed(() => false),
					);
					if (!requested) return textResponse("Lookup failed", 500);
					return received();
				}),
			),
		),
	),
);

export const POST = apiToHandler(ApiLive);
