import { Button } from "@cap/ui-solid";
import { useNavigate } from "@solidjs/router";
import { For, onMount } from "solid-js";
import IconLucideDatabase from "~icons/lucide/database";

import "@total-typescript/ts-reset/filter-boolean";
import { useI18n } from "~/i18n";
import { authStore } from "~/store";
import { commands } from "~/utils/tauri";

export default function AppsTab() {
	const { t } = useI18n();
	const navigate = useNavigate();
	const auth = authStore.createQuery();

	const isPro = () => auth.data?.plan?.upgraded;

	onMount(() => {
		void commands.checkUpgradedAndUpdate();
	});

	const apps = [
		{
			name: t("S3 Config"),
			description: t(
				"Connect your own S3 bucket for complete control over your data storage. All new shareable link uploads will be automatically uploaded to your configured S3 bucket, ensuring you maintain complete ownership and control over your content. Perfect for organizations requiring data sovereignty and custom storage policies.",
			),
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
				<h2 class="text-lg font-medium text-gray-12">{t("Integrations")}</h2>
				<p class="text-sm text-gray-10">
					{t(
						"Configure integrations to extend Cap's functionality and connect with third-party services.",
					)}
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
								{app.pro && !isPro() ? t("Upgrade to Pro") : t("Configure")}
							</Button>
						</div>
						<p class="text-[13px] text-gray-11">{app.description}</p>
					</div>
				)}
			</For>
		</div>
	);
}
