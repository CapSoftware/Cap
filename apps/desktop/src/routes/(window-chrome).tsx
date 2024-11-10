import type { RouteSectionProps } from "@solidjs/router";
import { onCleanup, onMount, ParentProps, Suspense } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Transition } from "solid-transition-group";
import titlebarState, { initializeTitlebar } from "~/utils/titlebar-state";

import Titlebar from "~/components/titlebar/Titlebar";
import { type as ostype } from "@tauri-apps/plugin-os";

export const route = {
  info: {
    AUTO_SHOW_WINDOW: false,
  },
};

export default function (props: RouteSectionProps) {
  let unlistenResize: () => void | undefined;

  onMount(async () => {
    unlistenResize = await initializeTitlebar();
    if (location.pathname === "/") getCurrentWindow().show();
  });

  onCleanup(() => {
    unlistenResize?.();
  });

  return (
    <div
      class={`${
        titlebarState.maximized ? "" : "rounded-[1.5rem] border"
      } bg-gray-100 border-gray-200 w-screen h-screen flex flex-col overflow-hidden transition-[border-radius] duration-300`}
    >
      {/* <Transition
        mode="outin"
        enterActiveClass="transition-opacity duration-100"
        exitActiveClass="transition-opacity duration-100"
        enterClass="opacity-0"
        exitToClass="opacity-0"
        > */}
      <Suspense
        fallback={
          <div class="w-full h-full flex items-center justify-center bg-gray-100">
            <div class="animate-spin">
              <IconCapLogo class="size-[4rem]" />
            </div>
          </div>
        }
      >
        <Titlebar />
        <Inner>{props.children}</Inner>
      </Suspense>
      {/* </Transition> */}
    </div>
  );
}

function Inner(props: ParentProps) {
  onMount(() => {
    if (location.pathname !== "/") getCurrentWindow().show();
  });

  return <>{props.children}</>;
}
