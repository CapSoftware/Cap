import { getAllWindows } from "@tauri-apps/api/window";
import { type as ostype } from "@tauri-apps/plugin-os";
import { Show, Suspense } from "solid-js";
import CropAreaRenderer from "~/components/CropAreaRenderer";
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
            <CropAreaRenderer
              bounds={bounds()}
              borderRadius={ostype() === "macos" ? 9 : 7}
            />
          );
        }}
      </Show>
    </Suspense>
  );
}
