import { createQuery } from "@tanstack/solid-query";
import { ErrorBoundary, For, Show } from "solid-js";
import { SolidMarkdown } from "solid-markdown";

import { AbsoluteInsetLoader } from "~/components/Loader";
import { apiClient } from "~/utils/web-api";
import { SettingsPageContent } from "./Setting";

export default function Page() {
	const changelog = createQuery(() => {
		return {
			queryKey: ["changelog"],
			queryFn: async () => {
				const response = await apiClient.desktop.getChangelogPosts({
					query: { origin: window.location.origin },
				});

				if (response.status !== 200) {
					throw new Error("Failed to fetch changelog");
				}
				return response.body;
			},
		};
	});

	return (
		<div class="cap-settings-page flex flex-col h-full custom-scroll">
			<SettingsPageContent class="max-w-none">
				<Show when={!changelog.isLoading} fallback={<AbsoluteInsetLoader />}>
					<div class="flex flex-col gap-6 text-sm font-normal">
						<Show
							when={!changelog.isError}
							fallback={
								<div class="text-(--text-primary) font-medium">
									{changelog.error instanceof Error
										? changelog.error.message
										: "Failed to fetch changelog"}
								</div>
							}
						>
							<ErrorBoundary
								fallback={(error) => (
									<div class="text-(--text-primary) font-medium">
										{error instanceof Error ? error.message : String(error)}
									</div>
								)}
							>
								<ul class="space-y-8">
									<For each={changelog.data ?? []}>
										{(entry, i) => (
											<li class="border-b-2 border-(--gray-200) pb-8 last:border-b-0">
												<div class="flex mb-2">
													<Show when={i() === 0}>
														<div class="bg-(--blue-400) text-(--text-primary) px-2 py-1 rounded-md uppercase font-bold">
															<span style="color: #fff" class="text-xs">
																New
															</span>
														</div>
													</Show>
												</div>
												<h3 class="text-sm font-semibold tracking-tight text-gray-12 mb-2">
													{entry.title}
												</h3>
												<div class="text-xs leading-relaxed text-gray-10 mb-4">
													Version {entry.version} -{" "}
													{new Date(entry.publishedAt).toLocaleDateString()}
												</div>
												<SolidMarkdown
													components={{
														a: (props) => <a {...props} target="_blank" />,
													}}
													class="prose dark:prose-invert prose-sm max-w-none text-(--text-tertiary)"
												>
													{entry.content}
												</SolidMarkdown>
											</li>
										)}
									</For>
								</ul>
							</ErrorBoundary>
						</Show>
					</div>
				</Show>
			</SettingsPageContent>
		</div>
	);
}
