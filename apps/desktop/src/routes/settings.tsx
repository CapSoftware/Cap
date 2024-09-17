import type { RouteSectionProps } from "@solidjs/router";

import Header from "~/components/Header";

export default function (props: RouteSectionProps) {
  return (
    <div class="rounded-[1.5rem] bg-gray-100 border border-gray-200 w-screen h-screen flex flex-col overflow-hidden">
      <Header />
      <div class="h-full flex flex-row divide-x divide-gray-200 text-[0.875rem] leading-[1.25rem]">
        <ul class="min-w-[12rem] h-full p-[0.625rem]">
          <li class="bg-gray-50 border border-gray-200 rounded-lg h-[2rem] px-[0.375rem] flex flex-row items-center gap-[0.375rem]">
            <IconCapHotkeys class="size-[1.25rem]" />
            <span>Shortcuts</span>
          </li>
        </ul>
        <div class="flex-1 bg-gray-50">{props.children}</div>
      </div>
    </div>
  );
}
