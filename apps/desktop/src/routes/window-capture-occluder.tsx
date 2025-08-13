import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { createResource, Show, Suspense } from "solid-js";
import { createCurrentRecordingQuery } from "~/utils/queries";

export default function () {
  const currentRecording = createCurrentRecordingQuery();

  getAllWindows().then((w) =>
    w.forEach((w) => {
      if (w.label === "camera" || w.label === "in-progress-recording")
        w.setFocus();
    })
  );

  const bounds = () => {
    if (!currentRecording.data) return;
    if ("window" in currentRecording.data.target) {
      return currentRecording.data.target.window.bounds;
    }
    if ("area" in currentRecording.data.target) {
      return currentRecording.data.target.area.bounds;
    }
  };

  return (
    <Suspense>
      <Show when={bounds()}>
        {(bounds) => {
          getAllWindows().then((w) =>
            w.forEach((w) => {
              if (w.label === "camera" || w.label === "in-progress-recording")
                w.setFocus();
            })
          );

          return (
            <div
              class="size-full"
              style={{
                "--crop-x": `${Math.round(bounds().x)}px`,
                "--crop-y": `${Math.round(bounds().y)}px`,
                "--crop-width": `${Math.round(bounds().width)}px`,
                "--crop-height": `${Math.round(bounds().height)}px`,
              }}
            >
              <div class="absolute inset-0 *:absolute *:bg-black/50 *:pointer-events-none">
                {/* Top blind */}
                <div class="top-0 left-0 w-full h-[--crop-y]" />
                {/* Bottom blind */}
                <div class="left-0 bottom-0 w-full top-[calc(var(--crop-y)+var(--crop-height))]" />
                {/* Left blind */}
                <div class="left-0 top-[--crop-y] w-[--crop-x] h-[--crop-height]" />
                {/* Right blind */}
                <div class="right-0 top-[--crop-y] left-[calc(var(--crop-x)+var(--crop-width))] h-[--crop-height]" />
              </div>
            </div>
          );
        }}
      </Show>
    </Suspense>
  );
}
