import type { RouteSectionProps } from "@solidjs/router";
import { onCleanup, onMount, ParentProps, Suspense } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { UnlistenFn } from "@tauri-apps/api/event";
import { AbsoluteInsetLoader } from "~/components/Loader";
import { initializeTitlebar } from "~/utils/titlebar-state";
import Titlebar from "~/components/titlebar/Titlebar";

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
        {/* prevents flicker idk */}
        <Suspense
          fallback={
            (() => {
              console.log("Inner window chrome suspense fallback");

              return <></>;
            }) as any
          }
        >
          <Inner>{props.children}</Inner>
        </Suspense>
      </Suspense>
      {/* </Transition> */}
    </div>
  );
}

function Inner(props: ParentProps) {
  onMount(() => {
    if (location.pathname !== "/") {
      setTimeout(() => getCurrentWindow().show(), 1000);
    }
  });

  return (
    <div class="animate-in fade-in flex-1 flex flex-col overflow-y-hidden">
      {props.children}
    </div>
  );
}
