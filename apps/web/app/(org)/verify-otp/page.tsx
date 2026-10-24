import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getSafeNextPath } from "../safe-next";
import { VerifyOTPForm } from "./form";

export const metadata = {
	title: "Verify Code | Cap",
};

export default async function VerifyOTPPage(props: {
	searchParams: Promise<{ email?: string; next?: string; lastSent?: string }>;
}) {
	const searchParams = await props.searchParams;
	const user = await getCurrentUser();

	if (user) {
		redirect(getSafeNextPath(searchParams.next, serverEnv().WEB_URL));
	}

	if (!searchParams.email) {
		redirect("/login");
	}

	return (
		<div className="flex h-screen w-full items-center justify-center">
			<Suspense fallback={null}>
				<VerifyOTPForm
					email={searchParams.email?.toLowerCase() ?? ""}
					next={searchParams.next}
					lastSent={searchParams.lastSent}
				/>
			</Suspense>
		</div>
	);
}
