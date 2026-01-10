import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AutoMode } from "./AutoMode";

export const metadata: Metadata = {
	title: "Auto Mode — Cap",
	description: "Create AI-powered screen recordings with automated narration",
};

export default async function AutoModePage() {
	const user = await getCurrentUser();

	if (!user || !user.id) {
		redirect("/login");
	}

	return <AutoMode userId={user.id} />;
}
