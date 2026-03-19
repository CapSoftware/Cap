import { db } from "@cap/database";
import { organizationInvites } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
	const { inviteId } = await request.json();

	try {
		await db()
			.delete(organizationInvites)
			.where(eq(organizationInvites.id, inviteId));

		return NextResponse.json({ success: true });
	} catch (error) {
		console.error("Error declining invite:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
