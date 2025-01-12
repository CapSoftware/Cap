import { type } from "@tauri-apps/plugin-os";
import { Show, Suspense } from "solid-js";
import AreaOccluder from "~/components/AreaOccluder";
import { createCurrentRecordingQuery } from "~/utils/queries";

export default function () {
  const currentRecording = createCurrentRecordingQuery();

  return (
    <Suspense>
      <Show
        when={
          currentRecording.data &&
          currentRecording.data.captureTarget.variant === "window" &&
          currentRecording.data.captureTarget.bounds
        }
      >
        {(bounds) => (
          <AreaOccluder
            bounds={bounds()}
            borderRadius={type() === "macos" ? 9 : 7}
          />
        )}
      </Show>
    </Suspense>
  );
}
