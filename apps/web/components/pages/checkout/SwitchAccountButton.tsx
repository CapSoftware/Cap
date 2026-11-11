"use client";

import { signOut } from "next-auth/react";
import { useState } from "react";

// /login sends anyone already signed in straight to `next`, so switching to
// the account that paid needs a sign-out first.
export function SwitchAccountButton({
	loginHref,
	className,
}: {
	loginHref: string;
	className: string;
}) {
	const [pending, setPending] = useState(false);

	return (
		<button
			type="button"
			disabled={pending}
			onClick={() => {
				setPending(true);
				signOut({ callbackUrl: loginHref });
			}}
			className={className}
		>
			{pending ? "Signing out..." : "Switch account"}
		</button>
	);
}
