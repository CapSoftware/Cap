import type { RouteSectionProps } from "@solidjs/router";
import { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import { onCleanup, onMount, ParentProps, Suspense } from "solid-js";

import { AbsoluteInsetLoader } from "~/components/Loader";
import { initializeTitlebar } from "~/utils/titlebar-state";
import {
  useWindowChromeContext,
  WindowChromeContext,
} from "./(window-chrome)/Context";
import { WindowControls } from "~/components/titlebar/Titlebar";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";

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
    <WindowChromeContext>
      <div class="w-screen h-screen max-h-screen flex flex-col overflow-hidden divide-y divide-slate-5">
        <Header />

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
    </WindowChromeContext>
  );
}

function Header() {
  const ctx = useWindowChromeContext()!;

  const isWindows = ostype() === "windows";

  return (
    <header
      class={cx(
        "flex items-center select-none space-x-1 shrink-0 bg-slate-2 h-9",
        isWindows ? "flex-row" : "pl-[5rem] flex-row-reverse"
      )}
      data-tauri-drag-region
    >
      {ctx.state()?.items}
      {isWindows && <CaptionControlsWindows11 class="!ml-auto" />}
    </header>
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
