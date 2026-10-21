import { DISCORD_URL } from "@/components/pages/about/content";
import { homepageOgImageUrl } from "@/components/pages/HomeTwo/metadata";

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
						content:
							"# Cap\nOpen-source screen recording for Mac, Windows, and Linux.",
					},
				],
				accessory: {
					type: 11,
					media: { url: "https://cap.so/apple-touch-icon.png" },
				},
			},
			{
				type: 12,
				items: [{ media: { url: homepageOgImageUrl } }],
			},
			{
				type: 1,
				components: [
					{
						type: 2,
						style: 5,
						label: "Join our Discord",
						url: DISCORD_URL,
					},
				],
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
