import { createQuery } from "@tanstack/solid-query";
import { createUniqueId, For } from "solid-js";
import { commands } from "~/utils/tauri";

export default function Debug() {
  const fails = createQuery(() => ({
    queryKey: ["fails"],
    queryFn: () => commands.listFails(),
  }));

  const orderedFails = () => Object.entries(fails.data ?? {});

  return (
    <main class="w-full h-full bg-gray-100 text-[--text-primary] p-4">
      <h2 class="text-2xl font-bold">Fail Points</h2>
      <ul class="p-2">
        <For each={orderedFails()}>
          {(fail) => {
            const id = createUniqueId();

            return (
              <li class="flex flex-row items-center gap-2">
                <input
                  class="size-4"
                  id={id}
                  type="checkbox"
                  checked={fail[1]}
                  value={fail[1].toString()}
                  onClick={(e) => {
                    e.preventDefault();
                    commands
                      .setFail(fail[0], !fail[1])
                      .then(() => fails.refetch());
                  }}
                />
                <label for={id}>{fail[0]}</label>
              </li>
            );
          }}
        </For>
      </ul>
    </main>
  );
}
