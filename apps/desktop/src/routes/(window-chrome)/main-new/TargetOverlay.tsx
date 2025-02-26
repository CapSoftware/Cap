import { Show } from "solid-js/web";
import { Transition } from "solid-transition-group";

interface TargetOverlayProps {
  show: boolean;
  onStartRecording: () => void;
  onTakeScreenshot: () => void;
  onCancel: () => void;
}

export function TargetOverlay(props: TargetOverlayProps) {
  return (
    <Transition
      enterClass="opacity-0"
      enterToClass="opacity-100"
      exitClass="opacity-100"
      exitToClass="opacity-0"
      mode="outin"
    >
      <Show when={props.show}>
        <div class="fixed inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-[2px] z-50">
          <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <div class="flex gap-2 items-center p-3 bg-white rounded-lg shadow-lg dark:bg-zinc-800">
              <button
                onClick={props.onStartRecording}
                class="flex gap-2 items-center px-3 py-2 font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600"
              >
                Start Recording
              </button>
              <button
                onClick={props.onTakeScreenshot}
                class="flex gap-2 items-center px-3 py-2 font-medium rounded-md bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-700 dark:hover:bg-zinc-600"
              >
                Take Screenshot
              </button>
              <button
                onClick={props.onCancel}
                class="flex gap-2 items-center px-3 py-2 font-medium rounded-md bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-700 dark:hover:bg-zinc-600"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Show>
    </Transition>
  );
} 