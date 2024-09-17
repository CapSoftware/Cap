import { Button } from "@cap/ui-solid";
import { For } from "solid-js";

export default function () {
  return (
    <div class="flex flex-col w-full h-full divide-y divide-gray-200">
      <ul class="flex-1 p-[0.625rem] flex flex-col gap-[0.5rem] w-full">
        <For each={["Start Recording", "Stop Recording"]}>
          {(item) => (
            <li class="w-full flex flex-row justify-between items-center">
              <span>{item}</span>
              <button
                type="button"
                class="w-[9rem] h-[2rem] border border-gray-200 rounded-lg text-gray-400"
              >
                Ctrl + Alt + R
              </button>
            </li>
          )}
        </For>
      </ul>
      <div class="flex flex-row-reverse p-[1rem]">
        <Button variant="secondary">Restore Defaults</Button>
      </div>
    </div>
  );
}
