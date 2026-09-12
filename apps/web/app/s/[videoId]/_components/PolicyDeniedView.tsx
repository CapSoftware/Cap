import { Button, Logo } from "@cap/ui";
import Link from "next/link";
import type React from "react";

export interface PolicyDeniedViewProps {
	videoId?: string;
	reason?: string;
}

export function PolicyDeniedView({ videoId, reason }: PolicyDeniedViewProps) {
	const loginHref = videoId
		? `/login?next=${encodeURIComponent(`/s/${videoId}`)}`
		: "/login";
	let title = "This video is private";
	let description: React.ReactNode = (
		<>
			If you own this video, please{" "}
			<Link href={loginHref} className="underline">
				sign in
			</Link>{" "}
			to manage sharing.
		</>
	);
	let showLoginButton = true;

	if (reason === "email_restriction_login_required") {
		title = "This video requires sign-in";
		description = (
			<>
				The owner of this video has restricted access. Please{" "}
				<Link href={loginHref} className="underline">
					sign in
				</Link>{" "}
				with an authorized email address to view.
			</>
		);
	} else if (reason === "email_restriction_denied") {
		title = "Access restricted";
		description =
			"Your email address does not meet the requirements set by the video owner.";
		showLoginButton = false;
	}

	return (
		<div className="flex flex-col justify-center items-center p-4 min-h-screen text-center">
			<Logo className="size-32" />
			<h1 className="mb-2 text-2xl font-semibold">{title}</h1>
			<p className="text-gray-400">{description}</p>
			{showLoginButton && (
				<Button asChild className="mt-6">
					<Link href={loginHref}>Sign in</Link>
				</Button>
			)}
		</div>
	);
}
