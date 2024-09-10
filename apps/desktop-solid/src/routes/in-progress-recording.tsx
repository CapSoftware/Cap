import { createSignal, type ComponentProps } from "solid-js";

import { commands } from "../utils/tauri";
import { createTimer } from "@solid-primitives/timer";
import { createMutation } from "@tanstack/solid-query";

export default function () {
  const start = Date.now();
  const [time, setTime] = createSignal(Date.now());
  let stopped = false;

  createTimer(
    () => {
      if (stopped) return;
      setTime(Date.now());
    },
    100,
    setInterval
  );

  const stopRecording = createMutation(() => ({
    mutationFn: async () => {
      stopped = true;
      await commands.stopRecording();
    },
  }));

  return (
    <div
      class="text-gray-400 flex flex-row items-stretch bg-gray-500 rounded-[0.75rem] w-full h-full animate-in fade-in"
      data-tauri-drag-region
    >
      <div class="flex flex-row justify-between p-[0.25rem] flex-1">
        <button
          disabled={stopRecording.isPending}
          class="p-[0.25rem] text-red-300 gap-[0.25rem] flex flex-row items-center hover:bg-red-transparent-20 transition-colors rounded-lg"
          type="button"
          onClick={() => stopRecording.mutate()}
        >
          <IconCapStopCircle />
          <span class="font-[700] text-[0.875rem]">
            {formatTime((time() - start) / 1000)}
          </span>
        </button>
        <ActionButton disabled>
          <IconCapPauseCircle />
        </ActionButton>
        <ActionButton disabled>
          <IconCapRestart />
        </ActionButton>
        <ActionButton disabled>
          <IconCapTrash />
        </ActionButton>
      </div>
      <div
        class="bg-white-transparent-5 cursor-move flex items-center justify-center  p-[0.25rem] border-l border-white-transparent-5"
        data-tauri-drag-region
      >
        <IconCapMoreVertical data-tauri-drag-region />
      </div>
    </div>
  );
}

function ActionButton(props: ComponentProps<"button">) {
  return (
    <button
      {...props}
      class="p-[0.25rem] enabled:hover:bg-white-transparent-5 enabled:hover:text-gray-50 rounded-lg transition-colors"
      type="button"
    />
  );
}

function formatTime(secs: number) {
  const minutes = Math.floor(secs / 60);
  const seconds = Math.round(secs % 60);

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
