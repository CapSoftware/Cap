export function createMediaServerWebhookUrl({
	webUrl,
	webhookBaseUrl,
	deploymentEnvironment,
	deploymentHost,
	automationBypassSecret,
	searchParams = {},
}: {
	webUrl: string;
	webhookBaseUrl?: string;
	deploymentEnvironment?: string;
	deploymentHost?: string;
	automationBypassSecret?: string;
	searchParams?: Record<string, string>;
}) {
	const previewHost =
		deploymentEnvironment === "preview" &&
		deploymentHost &&
		/^[a-z0-9-]+\.vercel\.app$/i.test(deploymentHost)
			? deploymentHost
			: undefined;
	const baseUrl =
		webhookBaseUrl || (previewHost ? `https://${previewHost}` : webUrl);
	const url = new URL("/api/webhooks/media-server/progress", baseUrl);
	for (const [key, value] of Object.entries(searchParams)) {
		url.searchParams.set(key, value);
	}
	if (
		previewHost &&
		url.origin === `https://${previewHost}` &&
		automationBypassSecret
	) {
		url.searchParams.set("x-vercel-protection-bypass", automationBypassSecret);
	}
	return url.toString();
}
