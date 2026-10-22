import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations, signedBaas } from "@cap/database/schema";
import { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { generateSignedBaaPdf } from "@/lib/baa/generate-signed-baa-pdf";

export async function GET(request: NextRequest) {
	const user = await getCurrentUser();
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const organizationIdParam =
		request.nextUrl.searchParams.get("organizationId");
	if (!organizationIdParam) {
		return Response.json({ error: "Missing organizationId" }, { status: 400 });
	}
	const organizationId = Organisation.OrganisationId.make(organizationIdParam);

	const [organization] = await db()
		.select({ ownerId: organizations.ownerId })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);

	if (!organization || organization.ownerId !== user.id) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}

	const [record] = await db()
		.select()
		.from(signedBaas)
		.where(eq(signedBaas.organizationId, organizationId))
		.limit(1);

	if (!record || record.status !== "active" || !record.signedAt) {
		return Response.json({ error: "No signed BAA found" }, { status: 404 });
	}

	const pdf = await generateSignedBaaPdf({
		executionId: record.id,
		entityName: record.entityName,
		entityType: record.entityType,
		entityAddress: record.entityAddress,
		signerName: record.signerName,
		signerTitle: record.signerTitle,
		noticesEmail: record.noticesEmail,
		signatureDataUrl: record.signatureData,
		signedAt: record.signedAt,
	});

	return new Response(Buffer.from(pdf), {
		headers: {
			"Content-Type": "application/pdf",
			"Content-Disposition":
				'attachment; filename="Cap-Software-BAA-Signed.pdf"',
			"Cache-Control": "private, no-store",
		},
	});
}
