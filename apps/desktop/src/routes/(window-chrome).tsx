import type { RouteSectionProps } from "@solidjs/router";
import {
  createEffect,
  onCleanup,
  onMount,
  ParentProps,
  Suspense,
} from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initializeTitlebar } from "~/utils/titlebar-state";

import Titlebar from "~/components/titlebar/Titlebar";

import { AbsoluteInsetLoader } from "~/components/Loader";
import { type as ostype } from "@tauri-apps/plugin-os";
import { commands } from "~/utils/tauri";

export const route = {
  info: {
    AUTO_SHOW_WINDOW: false,
  },
};

export default function (props: RouteSectionProps) {
  let unlistenResize: () => void | undefined;

  onMount(async () => {
    unlistenResize = await initializeTitlebar();
    if (ostype() === "macos") commands.positionTrafficLights(null);
    if (location.pathname === "/") getCurrentWindow().show();
  });

  onCleanup(() => {
    unlistenResize?.();
  });

  return (
    <div class="bg-gray-100 border-gray-200 w-screen h-screen max-h-screen flex flex-col overflow-hidden transition-[border-radius] duration-200">
      <Titlebar />
      {/* breaks sometimes */}
      {/* <Transition
        mode="outin"
        enterActiveClass="transition-opacity duration-100"
        exitActiveClass="transition-opacity duration-100"
        enterClass="opacity-0"
        exitToClass="opacity-0"
        > */}
      <Suspense fallback={<AbsoluteInsetLoader />}>
        <Inner>
          {/* prevents flicker idk */}
          <Suspense>{props.children}</Suspense>
        </Inner>
      </Suspense>
      {/* </Transition> */}
    </div>
  );
}

function Inner(props: ParentProps) {
  onMount(() => {
    if (location.pathname !== "/") getCurrentWindow().show();
  });

  return (
    <div class="animate-in fade-in flex-1 flex flex-col overflow-y-hidden">
      {props.children}
    </div>
  );
}
