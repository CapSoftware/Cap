import { DISCORD_URL } from "@/components/pages/about/content";
import { homepageOgImageUrl } from "@/components/pages/HomeTwo/metadata";
import { homepageSeo } from "@/components/pages/HomeTwo/seo";

export const discordLinkPreview = {
	component: {
		type: 17,
		accent_color: 9280752,
		components: [
			{
				type: 9,
				components: [
					{
						type: 10,
						content: `# [Cap](${homepageSeo.url})\n${homepageSeo.description}`,
					},
				],
				accessory: {
					type: 2,
					style: 5,
					label: "Join our Discord",
					url: DISCORD_URL,
				},
			},
			{
				type: 12,
				items: [{ media: { url: homepageOgImageUrl } }],
			},
		],
	},
} as const;

const discordComponentEmbedId = "discord:component-embed";

export function DiscordLinkPreview() {
	return (
		<script id={discordComponentEmbedId} type="application/json">
			{JSON.stringify(discordLinkPreview)}
		</script>
	);
}
