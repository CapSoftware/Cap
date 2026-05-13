import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationInvites } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
	const user = await getCurrentUser();
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let inviteId: unknown;
	try {
		({ inviteId } = await request.json());
	} catch {
		return NextResponse.json(
			{ error: "Invalid request body" },
			{ status: 400 },
		);
	}

	if (typeof inviteId !== "string" || !inviteId) {
		return NextResponse.json({ error: "Invalid invite ID" }, { status: 400 });
	}

	try {
		await db().transaction(async (tx) => {
			const [invite] = await tx
				.select()
				.from(organizationInvites)
				.where(eq(organizationInvites.id, inviteId))
				.for("update");

			if (!invite) {
				throw new Error("INVITE_NOT_FOUND");
			}

			if (user.email.toLowerCase() !== invite.invitedEmail.toLowerCase()) {
				throw new Error("EMAIL_MISMATCH");
			}

			await tx
				.delete(organizationInvites)
				.where(eq(organizationInvites.id, inviteId));
		});

		return NextResponse.json({ success: true });
	} catch (error) {
		if (error instanceof Error) {
			if (error.message === "INVITE_NOT_FOUND") {
				return NextResponse.json(
					{ error: "Invite not found" },
					{ status: 404 },
				);
			}
			if (error.message === "EMAIL_MISMATCH") {
				return NextResponse.json({ error: "Email mismatch" }, { status: 403 });
			}
		}
		console.error("Error declining invite:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
