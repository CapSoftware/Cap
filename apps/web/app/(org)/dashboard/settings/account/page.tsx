import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Settings } from "./Settings";

export const metadata: Metadata = {
	title: "Settings — Cap",
};

export default async function SettingsPage() {
	const user = await getCurrentUser();
	if (!user) redirect("/login");

	return <Settings user={user} />;
}
