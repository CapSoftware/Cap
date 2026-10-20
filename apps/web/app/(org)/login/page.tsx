import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import { faArrowLeft } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSafeNextPath } from "../safe-next";
import { LoginForm } from "./form";

export const dynamic = "force-dynamic";

export default async function LoginPage(props: {
	searchParams: Promise<{
		next?: string | string[];
		organizationId?: string | string[];
		connection_id?: string | string[];
		mobileProvider?: string | string[];
		sso?: string | string[];
		error?: string | string[];
	}>;
}) {
	const [searchParams, session] = await Promise.all([
		props.searchParams,
		getCurrentUser(),
	]);
	const [organizationId, connectionId, mobileProvider, sso, error] = [
		searchParams.organizationId,
		searchParams.connection_id,
		searchParams.mobileProvider,
		searchParams.sso,
		searchParams.error,
	].map((value) => (Array.isArray(value) ? value[0] : value));
	const isSsoEntry = Boolean(
		organizationId ||
			connectionId ||
			mobileProvider === "workos" ||
			sso === "1" ||
			error === "SsoSessionExpired" ||
			error === "SsoSignInFailed" ||
			error === "SsoMissingProfileAttributes" ||
			error === "profile_not_allowed_outside_organization" ||
			error === "signin_consent_denied",
	);

	if (session && !isSsoEntry) {
		redirect(getSafeNextPath(searchParams.next, serverEnv().WEB_URL));
	}

	return (
		<div className="flex relative justify-center items-center w-full h-screen bg-gray-2">
			<div className="flex absolute top-10 left-10 gap-2 justify-center items-center transition-opacity hover:opacity-75">
				<FontAwesomeIcon
					className="opacity-75 size-3 text-gray-12"
					icon={faArrowLeft}
				/>
				<Link className="text-gray-12" href="/">
					Home
				</Link>
			</div>
			<LoginForm />
		</div>
	);
}
