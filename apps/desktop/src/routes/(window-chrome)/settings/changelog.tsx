import { createQuery } from "@tanstack/solid-query";
import { cx } from "cva";
import { ErrorBoundary, For, onMount, Show, Suspense } from "solid-js";
import { SolidMarkdown } from "solid-markdown";

import { AbsoluteInsetLoader } from "~/components/Loader";
import { apiClient } from "~/utils/web-api";

export default function Page() {
	console.log("[Changelog] Component mounted");

	const changelog = createQuery(() => {
		console.log("[Changelog] Creating query");
		return {
			queryKey: ["changelog"],
			queryFn: async () => {
				console.log("[Changelog] Executing query function");
				try {
					const response = await apiClient.desktop.getChangelogPosts({
						query: { origin: window.location.origin },
					});

					console.log("[Changelog] Response", response);

					if (response.status !== 200) {
						console.error("[Changelog] Error status:", response.status);
						throw new Error("Failed to fetch changelog");
					}
					return response.body;
				} catch (error) {
					console.error("[Changelog] Error in query:", error);
					throw error;
				}
			},
		};
	});

	onMount(() => {
		console.log("[Changelog] Query state:", {
			isLoading: changelog.isLoading,
			isError: changelog.isError,
			error: changelog.error,
			data: changelog.data,
		});
	});

	const fadeIn = changelog.isLoading;

	return (
		<div class="flex flex-col h-full">
			<div class="relative flex-1 custom-scroll">
				<Suspense fallback={<AbsoluteInsetLoader />}>
					<div
						class={cx(
							"flex flex-col p-6 gap-6 text-sm font-normal",
							fadeIn && "animate-in fade-in",
						)}
					>
						<ErrorBoundary
							fallback={(e) => (
								<div class="text-[--text-primary] font-medium">
									{e.toString()}
								</div>
							)}
						>
							<ul class="space-y-8">
								<For each={changelog.data}>
									{(entry, i) => (
										<li class="border-b-2 border-[--gray-200] pb-8 last:border-b-0">
											<div class="flex mb-2">
												<Show when={i() === 0}>
													<div class="bg-[--blue-400] text-[--text-primary] px-2 py-1 rounded-md uppercase font-bold">
														<span style="color: #fff" class="text-xs">
															New
														</span>
													</div>
												</Show>
											</div>
											<h3 class="font-semibold text-[--text-primary] mb-2">
												{entry.title}
											</h3>
											<div class="text-[--text-tertiary] text-sm mb-4">
												Version {entry.version} -{" "}
												{new Date(entry.publishedAt).toLocaleDateString()}
											</div>
											<SolidMarkdown
												components={{
													a: (props) => <a {...props} target="_blank" />,
												}}
												class="prose dark:prose-invert prose-sm max-w-none text-[--text-tertiary]"
											>
												{entry.content}
											</SolidMarkdown>
										</li>
									)}
								</For>
							</ul>
						</ErrorBoundary>
					</div>
				</Suspense>
			</div>
		</div>
	);
}
