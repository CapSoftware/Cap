import type { RouteSectionProps } from "@solidjs/router";
import { Suspense } from "solid-js";
import { Transition } from "solid-transition-group";

import Header from "../components/Header";

export default function (props: RouteSectionProps) {
  return (
    <div class="rounded-[1.5rem] bg-gray-100 border border-gray-200 w-screen h-screen flex flex-col overflow-hidden">
      <Header />
      {/*<Transition
        mode="outin"
        enterClass="opacity-0 -translate-y-0.5"
        enterActiveClass="transition-[opacity,transform] duration-200"
        enterToClass="opacity-100 translate-0"
        exitClass="opacity-100"
        exitActiveClass="transition-[opacity,transform] duration-20"
        exitToClass="opacity-0"
        appear={false}
      >*/}
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
      {/*</Transition>*/}
    </div>
  );
}
