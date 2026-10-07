import { parse } from "tldts";

const VERCEL_CNAME_TARGET = "cname.vercel-dns.com";
const VERCEL_A_RECORD = "76.76.21.21";

export const isSubdomain = (raw: string): boolean => {
	const input =
		raw
			.trim()
			.replace(/^https?:\/\//i, "")
			.split("/")[0] ?? "";
	if (!input) return false;
	const host = (input.replace(/\.$/, "").split(":")[0] || "").toLowerCase();
	const { subdomain } = parse(host);
	return Boolean(subdomain);
};

export const getConfigResponse = async (domain: string) => {
	const response = await fetch(
		`https://api.vercel.com/v6/domains/${domain.toLowerCase()}/config?teamId=${
			process.env.VERCEL_TEAM_ID
		}&strict=true`,
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
				"Content-Type": "application/json",
			},
			cache: "no-store",
		},
	).then((res) => res.json());
	return response;
};

export const getDomainResponse = async (domain: string) => {
	const response = await fetch(
		`https://api.vercel.com/v9/projects/${
			process.env.VERCEL_PROJECT_ID
		}/domains/${domain.toLowerCase()}?teamId=${process.env.VERCEL_TEAM_ID}`,
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
				"Content-Type": "application/json",
			},
			cache: "no-store",
		},
	).then((res) => res.json());
	return response;
};

export const verifyDomain = async (domain: string) => {
	const response = await fetch(
		`https://api.vercel.com/v9/projects/${
			process.env.VERCEL_PROJECT_ID
		}/domains/${domain.toLowerCase()}/verify?teamId=${
			process.env.VERCEL_TEAM_ID
		}&strict=true`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
				"Content-Type": "application/json",
			},
		},
	).then((res) => res.json());
	return response;
};

export const addDomain = async (domain: string) => {
	const response = await fetch(
		`https://api.vercel.com/v9/projects/${process.env.VERCEL_PROJECT_ID}/domains?teamId=${process.env.VERCEL_TEAM_ID}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: domain }),
			cache: "no-store",
		},
	).then((res) => res.json());

	return response;
};

export const removeDomain = async (domain: string) => {
	const response = await fetch(
		`https://api.vercel.com/v9/projects/${
			process.env.VERCEL_PROJECT_ID
		}/domains/${domain.toLowerCase()}?teamId=${process.env.VERCEL_TEAM_ID}`,
		{
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
			},
		},
	).then((res) => res.json());

	return response;
};

export const getRequiredConfig = async (domain: string) => {
	// First try to get the records directly
	try {
		const recordsResponse = await fetch(
			`https://api.vercel.com/v4/domains/${domain.toLowerCase()}/records?limit=10&teamId=${
				process.env.VERCEL_TEAM_ID
			}`,
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
					"Content-Type": "application/json",
				},
				cache: "no-store",
			},
		).then((res) => res.json());

		if (recordsResponse.records) {
			const aRecord = recordsResponse.records.find(
				(record: any) => record.type === "A" && record.name === "",
			);

			if (aRecord) {
				return {
					configuredBy: "vercel",
					aValues: [aRecord.value],
					serviceType: "vercel",
				};
			}
		}
	} catch (_error) {
		// Continue to fallback
	}

	// Fallback to the old config endpoint
	const response = await fetch(
		`https://api.vercel.com/v6/domains/${domain.toLowerCase()}/config?teamId=${
			process.env.VERCEL_TEAM_ID
		}`,
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
				"Content-Type": "application/json",
			},
			cache: "no-store",
		},
	).then((res) => res.json());

	// If we still don't have the A record, try the project domains endpoint
	if (!response.aValues || response.aValues.length === 0) {
		const projectResponse = await fetch(
			`https://api.vercel.com/v9/projects/${process.env.VERCEL_PROJECT_ID}/domains?teamId=${process.env.VERCEL_TEAM_ID}`,
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
					"Content-Type": "application/json",
				},
				cache: "no-store",
			},
		).then((res) => res.json());

		if (projectResponse.domains) {
			const projectDomain = projectResponse.domains.find(
				(d: any) => d.name === domain,
			);
			if (projectDomain?.apexValue) {
				response.aValues = [projectDomain.apexValue];
			}
		}
	}

	return response;
};

export const checkDomainStatus = async (domain: string) => {
	try {
		const [domainJson, configJson, requiredConfigJson] = await Promise.all([
			getDomainResponse(domain),
			getConfigResponse(domain),
			getRequiredConfig(domain),
		]);

		let verified = false;

		if (configJson.misconfigured || domainJson?.error?.code === "not_found") {
			verified = false;
		} else if (domainJson.verified) {
			verified = true;
		} else {
			const verificationJson = await verifyDomain(domain);
			verified = verificationJson?.verified;
		}

		const currentAValues = configJson.aValues || [];
		const subdomain = isSubdomain(domain);

		// Vercel's recommendations are the source of truth, but the config
		// endpoint can omit them (e.g. for domains not using Vercel DNS). Fall
		// back to the well-known Vercel targets so the setup UI always has a
		// record to display instead of rendering empty.
		let recommendedCNAME: Array<{ rank: number; value: string }> =
			configJson.recommendedCNAME || [];
		let recommendedIPv4: Array<{ rank: number; value: string[] | string }> =
			configJson.recommendedIPv4 || [];

		if (subdomain && recommendedCNAME.length === 0) {
			recommendedCNAME = [{ rank: 0, value: VERCEL_CNAME_TARGET }];
		}
		if (!subdomain && recommendedIPv4.length === 0) {
			recommendedIPv4 = [{ rank: 0, value: [VERCEL_A_RECORD] }];
		}

		const requiredAValue =
			requiredConfigJson.aValues?.[0] ??
			(!subdomain ? VERCEL_A_RECORD : undefined);

		return {
			verified,
			config: {
				...configJson,
				verification: domainJson?.verification || [],
				currentAValues,
				requiredAValue,
				recommendedCNAME,
				recommendedIPv4,
			},
			status: domainJson,
		};
	} catch (error) {
		console.error("checkDomainStatus failed", { domain, error });
		return {
			verified: false,
			error: "Failed to check domain status",
		};
	}
};
