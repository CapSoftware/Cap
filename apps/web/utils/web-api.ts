import { contract } from "@cap/web-api-contract";
import { initClient } from "@ts-rest/core";
import { useState } from "react";

import { usePublicEnv } from "./public-env";

export function useApiClient() {
	const { webUrl } = usePublicEnv();
	const [client] = useState(() =>
		initClient(contract, {
			baseUrl:
				typeof window === "undefined"
					? `${webUrl.replace(/\/+$/, "")}/api`
					: "/api",
		}),
	);

	return client;
}
