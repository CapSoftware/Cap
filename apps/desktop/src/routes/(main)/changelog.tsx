import { createSignal, onMount, For, Show } from "solid-js";
import { clientEnv } from "~/utils/env";
import { Button } from "@cap/ui-solid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SolidMarkdown } from "solid-markdown";

interface ChangelogEntry {
  title: string;
  app: string;
  version: string;
  publishedAt: string;
  content: string;
}

export default function Page() {
  const [changelog, setChangelog] = createSignal<ChangelogEntry[]>([]);
  const [isLoading, setIsLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  const fetchChangelog = async () => {
    try {
      const response = await fetch(
        `${clientEnv.VITE_SERVER_URL}/api/changelog?origin=${window.location.origin}`
      );
      if (!response.ok) {
        throw new Error("Failed to fetch changelog");
      }
      const data = await response.json();
      setChangelog(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  onMount(() => {
    fetchChangelog();
  });

  return (
    <div class="flex flex-col p-6 gap-6 text-sm font-normal bg-gray-100 max-w-3xl mx-auto overflow-y-auto">
      <Show when={isLoading()}>
        <div class="text-gray-600">Loading...</div>
      </Show>
      <Show when={error()}>
        <div class="text-red-500 font-medium">Error: {error()}</div>
      </Show>
      <Show when={!isLoading() && !error()}>
        <For each={changelog()} class="space-y-8">
          {(entry) => (
            <div class="border-b-2 border-gray-200 pb-8">
              <div class="flex items-center gap-2 mb-2">
                <Show when={changelog().indexOf(entry) === 0}>
                  <div class="bg-blue-400 text-white px-2 py-1 rounded-md uppercase font-bold">
                    <span style="color: #fff" class="text-xs">
                      New
                    </span>
                  </div>
                </Show>
                <h3 class="text-xl font-semibold text-gray-800">
                  {entry.title}
                </h3>
              </div>
              <div class="text-gray-500 text-sm mb-4">
                Version {entry.version} -{" "}
                {new Date(entry.publishedAt).toLocaleDateString()}
              </div>
              <SolidMarkdown
                class="prose prose-sm max-w-none"
                children={entry.content}
              />
            </div>
          )}
        </For>
      </Show>
      <div>
        <Button
          onClick={() => {
            const window = getCurrentWindow();
            window.close();
          }}
          type="button"
          class="mt-4 w-full"
        >
          Close Window
        </Button>
      </div>
    </div>
  );
}
