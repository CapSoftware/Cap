import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { Settings } from "./Settings";
import { organizations } from "@cap/database/schema";

export const metadata: Metadata = {
	title: "Settings — Cap",
};

export default async function SettingsPage() {
	const user = await getCurrentUser();

	return <Settings user={user} />;
}
