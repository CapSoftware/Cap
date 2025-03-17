import type { RouteSectionProps } from "@solidjs/router";
import { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onCleanup, onMount, ParentProps, Suspense } from "solid-js";
import { AbsoluteInsetLoader } from "~/components/Loader";
import Titlebar from "~/components/titlebar/Titlebar";
import { initializeTitlebar } from "~/utils/titlebar-state";

export const route = {
  info: {
    AUTO_SHOW_WINDOW: false,
  },
};

export default function (props: RouteSectionProps) {
  let unlistenResize: UnlistenFn | undefined;

  onMount(async () => {
    console.log("window chrome mounted");
    unlistenResize = await initializeTitlebar();
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
      <Suspense
        fallback={
          (() => {
            console.log("Outer window chrome suspense fallback");
            return <AbsoluteInsetLoader />;
          }) as any
        }
      >
        <Inner>
          {/* prevents flicker idk */}
          <Suspense
            fallback={
              (() => {
                console.log("Inner window chrome suspense fallback");
              }) as any
            }
          >
            {props.children}
          </Suspense>
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
    <div class="flex overflow-y-hidden flex-col flex-1 animate-in fade-in">
      {props.children}
    </div>
  );
}
