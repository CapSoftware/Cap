import { For, Show, createResource, ErrorBoundary } from "solid-js";
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
  const [changelog] = createResource<Array<ChangelogEntry>>(async () => {
    const response = await fetch(
      `${clientEnv.VITE_SERVER_URL}/api/changelog?origin=${window.location.origin}`
    );
    if (!response.ok) throw new Error("Failed to fetch changelog");

    return await response.json();
  });

  return (
    <div class="flex flex-col p-6 gap-6 text-sm font-normal bg-gray-100 max-w-3xl mx-auto overflow-y-auto">
      <ErrorBoundary
        fallback={(e) => (
          <div class="text-red-500 font-medium">{e.toString()}</div>
        )}
      >
        <ul class="space-y-8">
          <For each={changelog()}>
            {(entry, i) => (
              <li class="border-b-2 border-gray-200 pb-8">
                <div class="flex mb-2">
                  <Show when={i() === 0}>
                    <div class="bg-blue-400 text-white px-2 py-1 rounded-md uppercase font-bold">
                      <span style="color: #fff" class="text-xs">
                        New
                      </span>
                    </div>
                  </Show>
                </div>
                <h3 class="text-xl font-semibold text-gray-800 mb-2">
                  {entry.title}
                </h3>
                <div class="text-gray-500 text-sm mb-4">
                  Version {entry.version} -{" "}
                  {new Date(entry.publishedAt).toLocaleDateString()}
                </div>
                <SolidMarkdown class="prose prose-sm max-w-none">
                  {entry.content}
                </SolidMarkdown>
              </li>
            )}
          </For>
        </ul>
      </ErrorBoundary>
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
