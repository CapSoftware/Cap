export interface SidebarLink {
	title: string;
	slug: string;
}

export interface SidebarGroup {
	title: string;
	items: SidebarLink[];
}

export const docsConfig = {
	sidebar: [
		{
			title: "Getting Started",
			items: [
				{ title: "Introduction", slug: "introduction" },
				{ title: "Installation", slug: "installation" },
				{ title: "Quickstart", slug: "quickstart" },
			],
		},
		{
			title: "Recording",
			items: [
				{ title: "Instant Mode", slug: "recording/instant-mode" },
				{ title: "Studio Mode", slug: "recording/studio-mode" },
				{ title: "Camera & Microphone", slug: "recording/camera-and-mic" },
				{
					title: "Keyboard Shortcuts",
					slug: "recording/keyboard-shortcuts",
				},
			],
		},
		{
			title: "Sharing & Playback",
			items: [
				{ title: "Share a Cap", slug: "sharing/share-a-cap" },
				{ title: "Embeds", slug: "sharing/embeds" },
				{ title: "Comments", slug: "sharing/comments" },
				{ title: "Analytics", slug: "sharing/analytics" },
			],
		},
		{
			title: "Self-hosting",
			items: [
				{ title: "Overview", slug: "self-hosting" },
				{ title: "S3: AWS", slug: "s3-config/aws-s3" },
				{ title: "S3: Cloudflare R2", slug: "s3-config/cloudflare-r2" },
			],
		},
		{
			title: "API & Developers",
			items: [
				{ title: "REST API", slug: "api/rest-api" },
				{ title: "Webhooks", slug: "api/webhooks" },
			],
		},
		{
			title: "Legal",
			items: [{ title: "Commercial License", slug: "commercial-license" }],
		},
	] satisfies SidebarGroup[],
};

export function flattenSidebar(): SidebarLink[] {
	return docsConfig.sidebar.flatMap((group) => group.items);
}

export function getAdjacentDocs(currentSlug: string) {
	const flat = flattenSidebar();
	const idx = flat.findIndex((item) => item.slug === currentSlug);
	return {
		prev: idx > 0 ? flat[idx - 1] : null,
		next: idx < flat.length - 1 ? flat[idx + 1] : null,
	};
}

export function getBreadcrumbs(currentSlug: string) {
	for (const group of docsConfig.sidebar) {
		const item = group.items.find((i) => i.slug === currentSlug);
		if (item) {
			return [
				{ title: "Docs", slug: "" },
				{ title: group.title, slug: group.items[0]?.slug ?? "" },
				{ title: item.title, slug: item.slug },
			];
		}
	}
	return [{ title: "Docs", slug: "" }];
}
