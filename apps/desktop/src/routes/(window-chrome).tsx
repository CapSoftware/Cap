import type { RouteSectionProps } from "@solidjs/router";
import { onMount, ParentProps, Suspense } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Transition } from "solid-transition-group";
import { Show } from "solid-js";

import Header from "../components/Header";
import { AbsoluteInsetLoader } from "~/components/Loader";

export const route = {
  info: {
    AUTO_SHOW_WINDOW: false,
  },
};

export default function (props: RouteSectionProps) {
  onMount(() => {
    if (location.pathname === "/") getCurrentWindow().show();
  });

  return (
    <div class="bg-gray-100 border border-gray-200 w-screen h-screen flex flex-col overflow-hidden relative">
      <Header />
      {/* breaks sometimes */}
      {/* <Transition
        mode="outin"
        enterActiveClass="transition-opacity duration-100"
        exitActiveClass="transition-opacity duration-100"
        enterClass="opacity-0"
        exitToClass="opacity-0"
      > */}
      <Suspense fallback={<AbsoluteInsetLoader />}>
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

  return (
    <div class="animate-in fade-in w-full h-full flex flex-col">
      {props.children}
    </div>
  );
}
