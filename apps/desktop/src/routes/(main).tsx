import type { RouteSectionProps } from "@solidjs/router";
import { Suspense } from "solid-js";
import { Transition } from "solid-transition-group";

import Header from "../components/Header";

export default function (props: RouteSectionProps) {
  return (
    <div class="rounded-[1.5rem] bg-gray-100 border border-gray-200 w-screen h-screen flex flex-col overflow-hidden">
      <Header />
      <Transition
        mode="outin"
        enterActiveClass="transition-opacity duration-100"
        exitActiveClass="transition-opacity duration-100"
        enterClass="opacity-0"
        exitToClass="opacity-0"
      >
        <Suspense
          fallback={
            <div class="w-full h-full flex items-center justify-center bg-gray-100">
              <div class="animate-spin">
                <IconCapLogo class="size-[4rem]" />
              </div>
            </div>
          }
        >
          {props.children}
        </Suspense>
      </Transition>
    </div>
  );
}
