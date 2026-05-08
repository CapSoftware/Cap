import { Button } from "@cap/ui-solid";
import { useNavigate } from "@solidjs/router";
import { For, onMount } from "solid-js";
import IconLucideDatabase from "~icons/lucide/database";

import "@total-typescript/ts-reset/filter-boolean";
import { authStore } from "~/store";
import { commands } from "~/utils/tauri";

const GoogleDriveIcon = (props: { class?: string }) => (
	<svg
		class={props.class}
		viewBox="0 0 87.3 78"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
	>
		<path
			d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"
			fill="#0066da"
		/>
		<path
			d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z"
			fill="#00ac47"
		/>
		<path
			d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"
			fill="#ea4335"
		/>
		<path
			d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"
			fill="#00832d"
		/>
		<path
			d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
			fill="#2684fc"
		/>
		<path
			d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
			fill="#ffba00"
		/>
	</svg>
);

export default function AppsTab() {
	const navigate = useNavigate();
	const auth = authStore.createQuery();

	const isPro = () => auth.data?.plan?.upgraded;

	onMount(() => {
		void commands.checkUpgradedAndUpdate();
	});

	const apps = [
		{
			name: "Google Drive",
			description:
				"Connect Google Drive for new shareable link uploads. Cap stores new videos in a private Cap folder in your Drive and continues serving them through Cap after normal access checks.",
			icon: GoogleDriveIcon,
			url: "/settings/integrations/google-drive-config",
			pro: true,
		},
		{
			name: "S3 Config",
			description:
				"Connect your own S3 bucket for complete control over your data storage. All new shareable link uploads will be automatically uploaded to your configured S3 bucket, ensuring you maintain complete ownership and control over your content. Perfect for organizations requiring data sovereignty and custom storage policies.",
			icon: IconLucideDatabase,
			url: "/settings/integrations/s3-config",
			pro: true,
		},
	];

	const handleAppClick = async (app: (typeof apps)[number]) => {
		try {
			if (app.pro && !isPro()) {
				await commands.showWindow("Upgrade");
				return;
			}
			navigate(app.url);
		} catch (error) {
			console.error("Error handling app click:", error);
		}
	};

	return (
		<div class="p-4 space-y-4">
			<div class="flex flex-col pb-4 border-b border-gray-2">
				<h2 class="text-lg font-medium text-gray-12">Integrations</h2>
				<p class="text-sm text-gray-10">
					Configure integrations to extend Cap's functionality and connect with
					third-party services.
				</p>
			</div>
			<For each={apps}>
				{(app) => (
					<div class="px-4 py-2 rounded-lg border bg-gray-2 border-gray-3">
						<div class="flex justify-between items-center pb-2 mb-3 border-b border-gray-3">
							<div class="flex gap-2 items-center">
								<app.icon class="w-4 h-4 text-gray-12" />
								<p class="text-sm font-medium text-gray-12">{app.name}</p>
							</div>
							<Button
								size="sm"
								variant="primary"
								onClick={() => handleAppClick(app)}
							>
								{app.pro && !isPro() ? "Upgrade to Pro" : "Configure"}
							</Button>
						</div>
						<p class="text-[13px] text-gray-11">{app.description}</p>
					</div>
				)}
			</For>
		</div>
	);
}
