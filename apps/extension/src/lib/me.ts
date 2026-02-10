import { capWebUrl } from "./cap-web";

export type ExtensionMeResponse = {
	user: {
		id: string;
		email: string;
		name: string | null;
		lastName: string | null;
		isPro: boolean;
		activeOrganizationId: string | null;
		defaultOrgId: string | null;
	};
	organizations: { id: string; name: string }[];
};

export const fetchExtensionMe = async (apiKey: string) => {
	const res = await fetch(capWebUrl("/api/extension/me"), {
		method: "GET",
		headers: {
			authorization: `Bearer ${apiKey}`,
		},
	});

	if (res.status === 401) {
		throw new Error("unauthorized");
	}

	if (!res.ok) {
		const text = await res.text();
		throw new Error(text || `Request failed: ${res.status}`);
	}

	return (await res.json()) as ExtensionMeResponse;
};
