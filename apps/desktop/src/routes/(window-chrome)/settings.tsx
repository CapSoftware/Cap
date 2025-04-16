import { Button } from "@cap/ui-solid";
import { A, type RouteSectionProps } from "@solidjs/router";
import { getVersion } from "@tauri-apps/api/app";
import "@total-typescript/ts-reset/filter-boolean";
import { createResource, For, Show, Suspense } from "solid-js";
import toast from "solid-toast";
import { SignInButton } from "~/components/SignInButton";

import { authStore } from "~/store";
import { trackEvent } from "~/utils/analytics";
import { commands } from "~/utils/tauri";

type MenuItem =
  | { type?: "link"; href: string; name: string; icon: any }
  | { type: "button"; name: string; icon: any; onClick: () => void };

let intercomInitialized = false;

export default function Settings(props: RouteSectionProps) {
  const auth = authStore.createQuery();
  const [version] = createResource(() => getVersion());

  const handleAuth = async () => {
    if (auth.data) {
      trackEvent("user_signed_out", { platform: "desktop" });
      authStore.set(undefined);
    } else {
      commands.showWindow("SignIn");
    }
  };

  const initIntercom = async () => {
    if (!intercomInitialized) {
      const Intercom = (await import("@intercom/messenger-js-sdk")).default;
      Intercom({
        app_id: "efxq71cv",
        hide_default_launcher: true,
        user_id: auth.data?.user_id ?? "",
        user_hash: auth.data?.intercom_hash ?? "",
        utm_source: "desktop",
      });
      intercomInitialized = true;
    }
  };

  const handleLiveChat = async () => {
    if (!auth.data) {
      toast.error("Please sign in to access live chat support");
      return;
    }

    await initIntercom();
    // @ts-ignore - Intercom types
    window.Intercom("show");
  };

  return (
    <div class="flex-1 flex flex-row divide-x divide-[--gray-200] text-[0.875rem] leading-[1.25rem] overflow-y-hidden">
      <div class="flex flex-col h-full bg-gray-100">
        <ul class="min-w-[12rem] h-full p-[0.625rem] space-y-1 text-[--text-primary]">
          <For
            each={
              [
                {
                  type: "link",
                  href: "general",
                  name: "General",
                  icon: IconCapSettings,
                },
                {
                  type: "link",
                  href: "hotkeys",
                  name: "Shortcuts",
                  icon: IconCapHotkeys,
                },
                {
                  type: "link",
                  href: "recordings",
                  name: "Previous Recordings",
                  icon: IconLucideSquarePlay,
                },
                // {
                //   type: "link",
                //   href: "screenshots",
                //   name: "Previous Screenshots",
                //   icon: IconLucideCamera,
                // },
                {
                  type: "link",
                  href: "integrations",
                  name: "Integrations",
                  icon: IconLucideUnplug,
                },
                {
                  type: "link",
                  href: "feedback",
                  name: "Feedback",
                  icon: IconLucideMessageSquarePlus,
                },
                // {
                //   type: "button",
                //   name: "Live Chat",
                //   icon: IconLucideMessageCircle,
                //   onClick: handleLiveChat,
                // },
                {
                  type: "link",
                  href: "changelog",
                  name: "Changelog",
                  icon: IconLucideBell,
                },
              ].filter(Boolean) as MenuItem[]
            }
          >
            {(item) => (
              <li>
                {item.type === "button" ? (
                  <button
                    onClick={item.onClick}
                    class="w-full rounded-lg h-[2rem] px-2 flex flex-row items-center gap-[0.375rem] transition-colors border hover:bg-gray-100 border-transparent"
                  >
                    <item.icon class="size-4" />
                    <span>{item.name}</span>
                  </button>
                ) : (
                  <A
                    href={item.href}
                    activeClass="bg-gray-200"
                    inactiveClass="hover:bg-gray-100 border-transparent"
                    class="rounded-lg h-[2rem] px-2 flex flex-row items-center gap-[0.375rem] transition-colors border"
                  >
                    <item.icon class="size-4" />
                    <span>{item.name}</span>
                  </A>
                )}
              </li>
            )}
          </For>
        </ul>
        <div class="p-[0.625rem] text-left flex flex-col">
          <Show when={version()}>
            {(v) => <p class="mb-1 text-xs text-gray-400">v{v()}</p>}
          </Show>
          {auth.data ? (
            <Button onClick={handleAuth} variant="secondary" class="w-full">
              Sign Out
            </Button>
          ) : (
            <SignInButton>Sign In</SignInButton>
          )}
        </div>
      </div>
      <div class="overflow-y-hidden flex-1 bg-gray-50 animate-in">
        <Suspense>{props.children}</Suspense>
      </div>
    </div>
  );
}
