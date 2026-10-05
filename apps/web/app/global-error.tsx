"use client";

import NextError from "next/error";
import { useEffect } from "react";
import { captureClientException } from "@/lib/client-sentry";

export default function GlobalError({
	error,
}: {
	error: Error & { digest?: string };
}) {
	useEffect(() => {
		captureClientException(error);
	}, [error]);

	return (
		<html lang="en">
			<body>
				<NextError statusCode={0} />
			</body>
		</html>
	);
}
