import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getLoomImportSnapshot } from "@/lib/loom-import/snapshot";
import { LoomImportJobView } from "./LoomImportJobView";

export const metadata: Metadata = {
	title: "Loom import — Cap",
};

export default async function Page({
	params,
	searchParams,
}: {
	params: Promise<{ jobId: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const [{ jobId }, query, user] = await Promise.all([
		params,
		searchParams,
		getCurrentUser(),
	]);
	if (!user) redirect("/login");

	const snapshot = await getLoomImportSnapshot({ jobId, userId: user.id });
	if (!snapshot) notFound();

	return (
		<LoomImportJobView
			key={jobId}
			initial={snapshot}
			returnedFromCheckout={query.upgrade === "true"}
		/>
	);
}
