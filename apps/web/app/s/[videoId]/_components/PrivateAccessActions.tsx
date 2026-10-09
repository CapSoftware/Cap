"use client";

import { Button } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { useCurrentUser } from "@/app/Layout/AuthContext";

export function PrivateAccessActions({ videoId }: { videoId: Video.VideoId }) {
	const user = useCurrentUser();
	const next = encodeURIComponent(`/s/${videoId}`);
	const loginUrl = `/login?next=${next}`;

	if (user) {
		return (
			<div className="space-y-3">
				<p>
					You're signed in as {user.email}. Use the account that was invited to
					view this recording.
				</p>
				<Button
					variant="dark"
					onClick={() => signOut({ callbackUrl: loginUrl })}
				>
					Switch account
				</Button>
			</div>
		);
	}

	return (
		<p>
			If you have access, <Link href={loginUrl}>sign in</Link> or{" "}
			<Link href={`/signup?next=${next}`}>create an account</Link> using the
			email address that was invited.
		</p>
	);
}
