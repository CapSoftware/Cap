import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOwnershipAccess } from "@/lib/recording-ownership-repository";
import { RecordingOwnership } from "./RecordingOwnership";

export const metadata: Metadata = { title: "Recording ownership — Cap" };

export default async function RecordingOwnershipPage() {
	const user = await getCurrentUser();
	if (!user) redirect("/auth/signin");
	if (!user.activeOrganizationId) redirect("/dashboard/caps");
	await requireOwnershipAccess(
		db(),
		user.activeOrganizationId,
		user.id,
		user.id,
	);
	return <RecordingOwnership key={user.activeOrganizationId} />;
}
