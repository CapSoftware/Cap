import { createSignal, createResource, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

interface MonitorInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  is_primary: boolean;
}

export function ScreenSelector(props: { onSelect: (screenName: string) => void }) {
  const [isOpen, setIsOpen] = createSignal(false);
  const [monitors] = createResource<MonitorInfo[]>(async () => {
    return await invoke("get_available_monitors");
  });

  return (
    <div class="relative inline-block">
      <button
        type="button"
        class="flex items-center gap-2 rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-white hover:bg-neutral-700 transition"
        onClick={() => setIsOpen(!isOpen())}
      >
        <span>Select Display</span>
      </button>

      <Show when={isOpen()}>
        <div class="absolute bottom-full mb-2 left-0 w-64 rounded-xl border border-neutral-700 bg-neutral-900 p-2 shadow-xl z-50">
          <For each={monitors()}>
            {(m) => (
              <button
                type="button"
                class="w-full flex items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-800 transition"
                onClick={() => { props.onSelect(m.name); setIsOpen(false); }}
              >
                <span>{m.name} ({m.width}x{m.height})</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
