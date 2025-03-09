import { Button } from "@cap/ui-solid";
import * as shell from "@tauri-apps/plugin-shell";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { Window } from "@tauri-apps/api/window";
import { createMutation } from "@tanstack/solid-query";

import callbackTemplate from "./callback.template";
import { authStore } from "~/store";
import { clientEnv } from "~/utils/env";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands } from "~/utils/tauri";
import { identifyUser, trackEvent } from "~/utils/analytics";

export default function Page() {
  const signIn = createMutation(() => ({
    mutationFn: async (abort: AbortController) => {
      const platform = import.meta.env.DEV ? "web" : "desktop";

      let session;

      if (platform === "web")
        session = await createLocalServerSession(abort.signal);
      else session = await createDeepLinkSession(abort.signal);

      await shell.open(session.url.toString());

      await processAuthData(await session.complete());

      await commands.showWindow("Main");

      // Add a small delay to ensure window is ready
      await new Promise((resolve) => setTimeout(resolve, 500));

      const mainWindow = await Window.getByLabel("main");
      mainWindow?.setFocus();

      getCurrentWindow().close();
    },
  }));

  return (
    <div class="flex flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400] flex-1 bg-gray-100">
      <div class="space-y-[0.375rem] flex-1">
        <IconCapLogo class="size-[3rem]" />
        <h1 class="text-[1rem] font-[700] text-black-transparent-80">
          Sign in to Cap
        </h1>
        <p class="text-gray-400">Beautiful screen recordings, owned by you.</p>
      </div>
      {signIn.isPending ? (
        <Button
          variant="secondary"
          onClick={() => {
            signIn.variables.abort();
            signIn.reset();
          }}
        >
          Cancel sign in
        </Button>
      ) : (
        <div class="flex flex-col gap-2">
          <Button onClick={() => signIn.mutate(new AbortController())}>
            Sign in with your browser
          </Button>
        </div>
      )}
    </div>
  );
}

function createSessionRequestUrl(
  port: string | null,
  platform: "web" | "desktop"
) {
  const callbackUrl = new URL(
    `/api/desktop/session/request`,
    clientEnv.VITE_SERVER_URL
  );

  if (port !== null) callbackUrl.searchParams.set("port", port);
  callbackUrl.searchParams.set("platform", platform);

  return callbackUrl;
}

type AuthData = { token: string; user_id: string; expires: number };

async function createLocalServerSession(signal: AbortSignal) {
  await invoke("plugin:oauth|stop").catch(() => {});

  const port: string = await invoke("plugin:oauth|start", {
    config: {
      response: callbackTemplate,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      },
      // Add a cleanup function to stop the server after handling the request
      cleanup: true,
    },
  });

  signal.onabort = () => {
    invoke("plugin:oauth|stop").catch(() => {});
  };

  let res: (url: URL) => void;
  const stopListening = await listen(
    "oauth://url",
    (data: { payload: string }) => {
      if (!data.payload.includes("token")) {
        return;
      }

      const urlObject = new URL(data.payload);
      res(urlObject);
    }
  );

  return {
    url: createSessionRequestUrl(port, "web"),
    complete: async () => {
      const url = await new Promise<URL>((r) => {
        res = r;
      });

      stopListening();

      if (signal.aborted) throw new Error("Sign in aborted");

      const token = url.searchParams.get("token");
      const user_id = url.searchParams.get("user_id");
      const expires = Number(url.searchParams.get("expires"));
      if (!token || !expires || !user_id)
        throw new Error("Invalid token or expires");

      return { token, user_id, expires };
    },
  };
}

async function createDeepLinkSession(signal: AbortSignal) {
  let res: (data: AuthData) => void;
  const p = new Promise<AuthData>((r) => {
    res = r;
  });
  const stopListening = await onOpenUrl(async (urls) => {
    for (const url of urls) {
      if (!url.includes("token=")) return;
      if (signal.aborted) return;

      const urlObject = new URL(url);
      const token = urlObject.searchParams.get("token");
      const user_id = urlObject.searchParams.get("user_id");
      const expires = Number(urlObject.searchParams.get("expires"));

      if (!token || !expires || !user_id) {
        throw new Error("Invalid signin params");
      }

      res({ token, user_id, expires });
    }
  });

  signal.onabort = () => {
    stopListening();
  };

  return {
    url: createSessionRequestUrl(null, "desktop"),
    complete: () => p,
  };
}

async function processAuthData({ token, user_id, expires }: AuthData) {
  identifyUser(user_id);
  trackEvent("user_signed_in", { platform: "desktop" });

  const existingAuth = await authStore.get();
  await authStore.set({
    token,
    user_id,
    intercom_hash: existingAuth?.intercom_hash ?? "",
    expires,
    plan: null,
  });

  await commands.updateAuthPlan();
}
