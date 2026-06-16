"use client";

import { Button } from "@cap/ui";
import { useEffect } from "react";

export default function CollectionError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error("Public collection page error:", error);
	}, [error]);

	return (
		<div className="wrapper flex flex-col items-center justify-center h-screen text-center">
			<h1 className="text-5xl md:text-6xl font-medium">Something went wrong</h1>
			<p className="text-xl md:text-2xl mt-2 mb-6 text-gray-400">
				This collection could not be loaded right now.
			</p>
			<Button type="button" variant="gray" size="sm" onClick={reset}>
				Try again
			</Button>
		</div>
	);
}
