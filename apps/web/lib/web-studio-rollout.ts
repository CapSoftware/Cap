function allowlistEntries() {
	return (process.env.CAP_WEB_EDITOR_STUDIO_ALLOWLIST ?? "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
}

function productionDeployment() {
	return (
		process.env.VERCEL_ENV === "production" ||
		(process.env.VERCEL_ENV === undefined &&
			process.env.NODE_ENV === "production")
	);
}

export function isWebStudioEnabledForEmail(email: string | null | undefined) {
	if (process.env.CAP_WEB_EDITOR_STUDIO_ENABLED !== "enabled") return false;
	const normalized = email?.trim().toLowerCase();
	if (!normalized?.includes("@")) return false;
	const domain = normalized.slice(normalized.lastIndexOf("@"));
	return allowlistEntries().some(
		(entry) =>
			entry === normalized ||
			(entry.startsWith("@") && entry === domain) ||
			(entry === "*" && !productionDeployment()),
	);
}
