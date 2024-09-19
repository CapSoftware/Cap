import { A, type RouteSectionProps } from "@solidjs/router";
import { For } from "solid-js";

export default function (props: RouteSectionProps) {
  return (
    <div class="h-full flex flex-row divide-x divide-gray-200 text-[0.875rem] leading-[1.25rem]">
      <ul class="min-w-[12rem] h-full p-[0.625rem]">
        <For each={[{ href: "hotkeys", name: "Shortcuts" }]}>
          {(item) => (
            <li>
              <A
                href={item.href}
                class="bg-gray-50 border border-gray-200 rounded-lg h-[2rem] px-[0.375rem] flex flex-row items-center gap-[0.375rem]"
              >
                <IconCapHotkeys class="size-[1.25rem]" />
                <span>{item.name}</span>
              </A>
            </li>
          )}
        </For>
      </ul>
      <div class="flex-1 bg-gray-50">{props.children}</div>
    </div>
  );
}
