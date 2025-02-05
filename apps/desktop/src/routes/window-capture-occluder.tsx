import { type as ostype } from "@tauri-apps/plugin-os";
import { Show, Suspense } from "solid-js";
import CropAreaRenderer from "~/components/CropAreaRenderer";
import { createCurrentRecordingQuery } from "~/utils/queries";

export default function () {
  const currentRecording = createCurrentRecordingQuery();

  return (
    <Suspense>
      <Show
        when={
          currentRecording.data &&
          (currentRecording.data.captureTarget.variant !== "screen") &&
          currentRecording.data.captureTarget.bounds
        }
      >
        {(bounds) => (
          <CropAreaRenderer
            bounds={bounds()}
            borderRadius={ostype() === "macos" ? 9 : 7}
          />
        )}
      </Show>
    </Suspense>
  );
}
