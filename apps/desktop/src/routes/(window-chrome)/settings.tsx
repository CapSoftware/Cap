import { Button } from "@cap/ui-solid";
import { A, type RouteSectionProps } from "@solidjs/router";
import { getVersion } from "@tauri-apps/api/app";
import "@total-typescript/ts-reset/filter-boolean";
import { createResource, For, Show, Suspense } from "solid-js";
import toast from "solid-toast";
import { SignInButton } from "~/components/SignInButton";

import { authStore } from "~/store";
import { trackEvent } from "~/utils/analytics";

let intercomInitialized = false;

export default function Settings(props: RouteSectionProps) {
  const auth = authStore.createQuery();
  const [version] = createResource(() => getVersion());

  const handleAuth = async () => {
    if (auth.data) {
      trackEvent("user_signed_out", { platform: "desktop" });
      authStore.set(undefined);
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
    <div class="flex-1 flex flex-row divide-x divide-slate-5 text-[0.875rem] leading-[1.25rem] overflow-y-hidden">
      <div class="flex flex-col h-full bg-slate-2">
        <ul class="min-w-[12rem] h-full p-[0.625rem] space-y-1 text-slate-12">
          <For
            each={[
              {
                href: "general",
                name: "General",
                icon: IconCapSettings,
              },
              {
                href: "hotkeys",
                name: "Shortcuts",
                icon: IconCapHotkeys,
              },
              {
                href: "recordings",
                name: "Previous Recordings",
                icon: IconLucideSquarePlay,
              },
              {
                href: "integrations",
                name: "Integrations",
                icon: IconLucideUnplug,
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
                  activeClass="bg-gray-5"
                  class="rounded-md h-[2rem] px-2 flex flex-row items-center gap-[0.375rem] transition-colors"
                >
                  <item.icon class="size-4" />
                  <span>{item.name}</span>
                </A>
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
      <div class="overflow-y-hidden flex-1 animate-in">
        <Suspense>{props.children}</Suspense>
      </div>
    </div>
  );
}
