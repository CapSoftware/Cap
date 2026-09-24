export function isWebStudioEnabledForEmail(email: string | null | undefined) {
	return (
		process.env.CAP_WEB_EDITOR_STUDIO_ENABLED === "enabled" &&
		email?.trim().toLowerCase() === "richie@mcilroy.co"
	);
}
