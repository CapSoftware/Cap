import { createMousePosition } from "@solid-primitives/mouse";
import {
  currentMonitor,
  getAllWindows,
  getCurrentWindow,
  monitorFromPoint,
} from "@tauri-apps/api/window";
import { Button } from "@cap/ui-solid";
import { onCleanup, createSignal, For, Show } from "solid-js";
import { useParams, useSearchParams } from "@solidjs/router";

import { createOptionsQuery } from "~/utils/queries";
import { commands, events } from "~/utils/tauri";

export default function () {
  const [params] = useSearchParams<{ displayId: string }>();
  const { rawOptions } = createOptionsQuery();

  const [overDisplay, setOverDisplay] = createSignal<string | null>(null);

  events.displayUnderCursorChanged.listen((event) => {
    setOverDisplay(event.payload.display_id);
  });

  return (
    <Show when={rawOptions.targetMode === "screen"}>
      {(_) => {
        return (
          <div
            data-over={overDisplay() === params.displayId}
            class="w-screen h-screen flex flex-col items-center justify-center bg-black/40 data-[over='true']:bg-blue-500/30 transition-colors"
          >
            <Button
              size="lg"
              onClick={() => {
                commands.startRecording({
                  capture_target: {
                    variant: "screen",
                    id: Number(params.displayId),
                  },
                  mode: rawOptions.mode,
                  capture_system_audio: rawOptions.captureSystemAudio,
                });
              }}
            >
              Start Recording
            </Button>
          </div>
        );
      }}
    </Show>
  );
}
