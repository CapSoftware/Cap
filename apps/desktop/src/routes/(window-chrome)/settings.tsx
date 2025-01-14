import { A, type RouteSectionProps } from "@solidjs/router";
import { createResource, For, Show, Suspense } from "solid-js";
import { Button } from "@cap/ui-solid";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import "@total-typescript/ts-reset/filter-boolean";

import { commands } from "~/utils/tauri";
import { authStore } from "~/store";

export default function Settings(props: RouteSectionProps) {
  const [auth] = createResource(() => authStore.get());

  const handleSignOut = async () => {
    await commands.deleteAuthOpenSignin();
  };

  const handleSignIn = async () => {
    await emit("start-auth");
    await commands.openMainWindow();
    const window = await getCurrentWindow();
    await window.close();
  };

  const [version] = createResource(() => getVersion());

  return (
    <div class="flex-1 flex flex-row divide-x divide-[--gray-200] text-[0.875rem] leading-[1.25rem] overflow-y-hidden">
      <div class="h-full flex flex-col">
        <ul class="min-w-[12rem] h-full p-[0.625rem] space-y-2 text-[--text-primary]">
          <For
            each={[
              { href: "general", name: "General", icon: IconCapSettings },
              { href: "config", name: "Config", icon: IconLucideVideo },
              { href: "hotkeys", name: "Shortcuts", icon: IconCapHotkeys },
              {
                href: "recordings",
                name: "Previous Recordings",
                icon: IconLucideSquarePlay,
              },
              {
                href: "screenshots",
                name: "Previous Screenshots",
                icon: IconLucideCamera,
              },
              {
                href: "apps",
                name: "Cap Apps",
                icon: IconLucideLayoutGrid,
              },
              {
                href: "feedback",
                name: "Feedback",
                icon: IconLucideMessageSquarePlus,
              },
              {
                href: "changelog",
                name: "Changelog",
                icon: IconLucideBell,
              },
            ].filter(Boolean)}
          >
            {(item) => (
              <li>
                <A
                  href={item.href}
                  activeClass="bg-blue-50 border-blue-200 text-blue-700"
                  inactiveClass="hover:bg-gray-100 border-transparent"
                  class="rounded-lg h-[2rem] px-[0.375rem] flex flex-row items-center gap-[0.375rem] transition-colors border"
                >
                  <item.icon class="size-[1.25rem]" />
                  <span>{item.name}</span>
                </A>
              </li>
            )}
          </For>
        </ul>
        <div class="p-[0.625rem]">
          <Show when={version()}>
            {(v) => <p class="text-xs text-gray-400 mb-1">v{v()}</p>}
          </Show>
          <Button
            onClick={auth() ? handleSignOut : handleSignIn}
            variant="secondary"
            class="w-full"
          >
            {auth() ? "Sign Out" : "Sign in"}
          </Button>
        </div>
      </div>
      <div class="flex-1 bg-gray-50 overflow-y-hidden animate-in">
        <Suspense>{props.children}</Suspense>
      </div>
    </div>
  );
}
