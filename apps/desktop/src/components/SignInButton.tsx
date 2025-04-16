import { Button } from "@cap/ui-solid";
import { createMutation } from "@tanstack/solid-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import * as shell from "@tauri-apps/plugin-shell";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { ComponentProps } from "solid-js";
import { authStore } from "~/store";
import { identifyUser, trackEvent } from "~/utils/analytics";
import { clientEnv } from "~/utils/env";
import { commands } from "~/utils/tauri";
import callbackTemplate from "./callback.template";

export function SignInButton(
  props: Omit<ComponentProps<typeof Button>, "onClick">
) {
  const signIn = createMutation(() => ({
    mutationFn: async (abort: AbortController) => {
      const platform = import.meta.env.DEV ? "web" : "desktop";

      let session;

      if (platform === "web")
        session = await createLocalServerSession(abort.signal);
      else session = await createDeepLinkSession(abort.signal);

      await shell.open(session.url.toString());

      await processAuthData(await session.complete());

      getCurrentWindow().setFocus();
    },
  }));

  return (
    <Button
      size="md"
      class="flex flex-grow justify-center items-center"
      {...props}
      variant={signIn.isPending ? "secondary" : props.variant}
      onClick={() => {
        if (signIn.isPending) {
          signIn.variables.abort();
          signIn.reset();
        } else {
          signIn.mutate(new AbortController());
        }
      }}
    >
      {signIn.isPending ? "Cancel Sign In" : props.children ?? "Sign In"}
    </Button>
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
