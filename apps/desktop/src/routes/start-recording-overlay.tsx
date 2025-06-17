import { createMousePosition } from "@solid-primitives/mouse";
import { getAllWindows, monitorFromPoint } from "@tauri-apps/api/window";
import { Button } from "@cap/ui-solid";
import { createSignal, For, Show } from "solid-js";

import { createOptionsQuery } from "~/utils/queries";
import { onCleanup } from "solid-js";

export default function () {
  const { rawOptions } = createOptionsQuery();

  const mousePosition = createMousePosition();

  const interval = setInterval(async () => {
    console.log(await monitorFromPoint(mousePosition.x, mousePosition.y));
    console.log("interval");
    const w = await getAllWindows();
    setWindows(w.map((w) => w.label));
  }, 50);
  onCleanup(() => clearInterval(interval));

  const [windows, setWindows] = createSignal([]);
  const [over, setOver] = createSignal(true);

  return (
    <Show when={rawOptions.targetMode === "screen" && over()}>
      <div
        class="w-screen h-screen bg-blue-500/10 flex flex-col items-center justify-center"
        onPointerOver={() => {
          setOver(true);
        }}
        onPointerLeave={() => {
          setOver(false);
        }}
      >
        <Button size="lg">Start Recording</Button>
        <For each={windows()}>{(w) => <span>{w()}</span>}</For>
      </div>
    </Show>
  );
}
