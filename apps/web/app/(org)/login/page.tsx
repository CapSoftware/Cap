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
	searchParams: Promise<{ next?: string | string[] }>;
}) {
	const [searchParams, session] = await Promise.all([
		props.searchParams,
		getCurrentUser(),
	]);

	if (session) {
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
