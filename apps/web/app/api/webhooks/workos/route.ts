import { db } from "@cap/database";
import { getWorkOS } from "@cap/database/auth/sso";
import { organizations } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { after } from "next/server";
import {
	requestDirectorySync,
	syncOrganizationDirectory,
} from "@/lib/sso/directory-sync";
import { verifyWorkosSignature } from "@/lib/sso/workos-webhook";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const SYNC_BUDGET_MS = 240_000;

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

export async function POST(request: Request) {
	const secret = serverEnv().WORKOS_WEBHOOK_SECRET;
	if (!secret) return new Response("Not configured", { status: 503 });
	const payload = await request.text();
	if (
		!verifyWorkosSignature(
			payload,
			request.headers.get("workos-signature"),
			secret,
		)
	) {
		return new Response("Invalid signature", { status: 400 });
	}
	let event: { event?: unknown; data?: unknown };
	try {
		event = JSON.parse(payload);
	} catch {
		return new Response("Invalid payload", { status: 400 });
	}
	if (typeof event.event !== "string" || !event.event.startsWith("dsync.")) {
		return Response.json({ received: true });
	}

	let workosOrganizationId = eventOrganization(event.data);
	if (!workosOrganizationId) {
		const directoryId = eventDirectory(event.data);
		if (directoryId) {
			const directory = await getWorkOS()
				.directorySync.getDirectory(directoryId)
				.catch(() => null);
			workosOrganizationId = directory?.organizationId ?? null;
		}
	}
	if (!workosOrganizationId) return Response.json({ received: true });

	const [organization] = await db()
		.select({ id: organizations.id })
		.from(organizations)
		.where(eq(organizations.workosOrganizationId, workosOrganizationId))
		.limit(1);
	if (!organization) return Response.json({ received: true });

	const organizationId = Organisation.OrganisationId.make(organization.id);
	await requestDirectorySync(organizationId);
	after(() =>
		syncOrganizationDirectory(organizationId, Date.now() + SYNC_BUDGET_MS)
			.then(() => undefined)
			.catch(() => undefined),
	);
	return Response.json({ received: true });
}
