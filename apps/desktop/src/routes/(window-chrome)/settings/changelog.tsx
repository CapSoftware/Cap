import { For, Show, ErrorBoundary, Suspense } from "solid-js";
import { SolidMarkdown } from "solid-markdown";
import { createQuery } from "@tanstack/solid-query";
import { cx } from "cva";

import { AbsoluteInsetLoader } from "~/components/Loader";
import { apiClient } from "~/utils/web-api";

export default function Page() {
  const changelog = createQuery(() => ({
    queryKey: ["changelog"],
    queryFn: async () => {
      const response = await apiClient.desktop.getChangelogPosts({
        query: { origin: window.location.origin },
      });

      if (response.status !== 200) throw new Error("Failed to fetch changelog");
      return response.body;
    },
  }));

  let fadeIn = changelog.isLoading;

  return (
    <div class="h-full flex flex-col">
      <div class="flex-1 overflow-y-auto relative">
        <Suspense fallback={<AbsoluteInsetLoader />}>
          <div
            class={cx(
              "flex flex-col p-6 gap-6 text-sm font-normal",
              fadeIn && "animate-in fade-in"
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
                      <SolidMarkdown class="prose prose-sm max-w-none text-[--text-tertiary]">
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
