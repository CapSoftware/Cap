"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useCurrentUser } from "@/app/Layout/AuthContext";

export function ShareNavigation() {
	const user = useCurrentUser();
	if (!user) return null;
	return (
		<Link
			href="/dashboard/caps"
			className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-lg px-2 text-sm text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
		>
			<ArrowLeft className="size-4" aria-hidden="true" />
			<span className="sr-only sm:not-sr-only">My Caps</span>
		</Link>
	);
}
