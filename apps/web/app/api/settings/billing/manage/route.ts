import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { stripe } from "@cap/utils";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
	const user = await getCurrentUser();
	let customerId = user?.stripeCustomerId;

	if (!user) {
		console.error("User not found");

		return Response.json({ error: true }, { status: 401 });
	}

	if (!user.stripeCustomerId) {
		const customer = await stripe().customers.create({
			email: user.email,
			metadata: {
				userId: user.id,
			},
		});

		await db()
			.update(users)
			.set({
				stripeCustomerId: customer.id,
			})
			.where(eq(users.id, user.id));

		customerId = customer.id;
	}

	const { url } = await stripe().billingPortal.sessions.create({
		customer: customerId as string,
		return_url: `${serverEnv().WEB_URL}/dashboard/settings/organization`,
	});
	return NextResponse.json(url);
}
