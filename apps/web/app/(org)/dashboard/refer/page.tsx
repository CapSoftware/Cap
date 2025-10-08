import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env/server";
import { redirect } from "next/navigation";
import ReferClient from "./ReferClient";

export const metadata = {
	title: "Refer - Cap",
	description: "Earn rewards by referring friends to Cap",
};

async function generateEmbedToken(
	userId: string,
	userName: string | null,
	userEmail: string,
	userImage: string | null,
) {
	const response = await fetch("https://api.dub.co/tokens/embed/referrals", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${serverEnv().DUB_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			tenantId: userId,
			partner: {
				name: userName || userEmail,
				email: userEmail,
				image: userImage || undefined,
				tenantId: userId,
			},
		}),
	});

	if (!response.ok) {
		throw new Error("Failed to generate embed token");
	}

	const data = await response.json();
	return data.publicToken || data.token;
}

export default async function ReferPage() {
	// Check if Dub Partners is available
	if (!serverEnv().DUB_API_KEY) {
		redirect("/dashboard/caps");
	}

	const user = await getCurrentUser();
	if (!user || !user.id) {
		redirect("/login");
	}

	const token = await generateEmbedToken(
		user.id,
		user.name,
		user.email,
		user.image,
	);

	return <ReferClient token={token} />;
}
