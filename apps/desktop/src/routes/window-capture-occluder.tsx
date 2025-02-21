import { getAllWindows } from "@tauri-apps/api/window";
import { type as ostype } from "@tauri-apps/plugin-os";
import { onMount, Show, Suspense } from "solid-js";
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

  return (
    <Suspense>
      <Show
        when={
          currentRecording.data &&
          currentRecording.data.captureTarget.variant !== "screen" &&
          currentRecording.data.captureTarget.bounds
        }
      >
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
