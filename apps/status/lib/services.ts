import type { ServiceDefinition } from "./types";

export const SERVICES: ServiceDefinition[] = [
	{
		id: "website",
		name: "Website",
		description: "The Cap website and downloads.",
		env: "STATUS_WEBSITE_URL",
		defaultUrl: "https://cap.so",
		method: "HEAD",
	},
	{
		id: "api",
		name: "API & authentication",
		description: "Availability of Cap’s authentication API.",
		env: "STATUS_API_URL",
		defaultUrl: "https://cap.so/api/auth/providers",
		method: "GET",
		validation: "auth",
	},
	{
		id: "sharing",
		name: "Video sharing",
		description: "Opening and viewing shared recordings.",
		env: "STATUS_SHARING_URL",
		method: "HEAD",
	},
	{
		id: "storage",
		name: "Storage & delivery",
		description: "Access to recordings on Cap’s storage and CDN.",
		env: "STATUS_STORAGE_URL",
		method: "HEAD",
	},
	{
		id: "media",
		name: "Media processing",
		description: "The service that processes and converts your recordings.",
		env: "STATUS_MEDIA_URL",
		method: "GET",
		validation: "media",
	},
	{
		id: "render",
		name: "Cloud rendering",
		description: "The render coordinator and its available workers.",
		env: "STATUS_RENDER_URL",
		method: "GET",
		validation: "render",
	},
];

export function serviceUrl(service: ServiceDefinition): string | undefined {
	const value = process.env[service.env]?.trim() || service.defaultUrl;
	if (!value) return undefined;
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error(`Invalid HTTPS endpoint for ${service.id}`);
	}
	return url.toString();
}

export function isConfigured(service: ServiceDefinition): boolean {
	try {
		return Boolean(serviceUrl(service));
	} catch {
		return false;
	}
}
