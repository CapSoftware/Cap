import { Button } from "@cap/ui-solid";
import { createMutation } from "@tanstack/solid-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import * as shell from "@tauri-apps/plugin-shell";
import { z } from "zod";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { ComponentProps } from "solid-js";
import { authStore, generalSettingsStore } from "~/store";
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

async function createSessionRequestUrl(
  port: string | null,
  platform: "web" | "desktop"
) {
  const serverUrl =
    (await generalSettingsStore.get())?.serverUrl ?? "https://cap.so";
  const callbackUrl = new URL(
    `/api/desktop/session/request?type=api_key`,
    serverUrl
  );

  if (port !== null) callbackUrl.searchParams.set("port", port);
  callbackUrl.searchParams.set("platform", platform);

  return callbackUrl;
}

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
      console.log(data);
      if (
        !(data.payload.includes("token") || data.payload.includes("api_key"))
      ) {
        return;
      }

      const urlObject = new URL(data.payload);
      res(urlObject);
    }
  );

  return {
    url: await createSessionRequestUrl(port, "web"),
    complete: async () => {
      const url = await new Promise<URL>((r) => {
        res = r;
      });

      console.log(url);
      stopListening();

      if (signal.aborted) throw new Error("Sign in aborted");

      return paramsValidator.parse({
        type: url.searchParams.get("type"),
        api_key: url.searchParams.get("api_key"),
        user_id: url.searchParams.get("user_id"),
      });
    },
  };
}

const paramsValidator = z.object({
  type: z.literal("api_key"),
  api_key: z.string(),
  user_id: z.string(),
});

async function createDeepLinkSession(signal: AbortSignal) {
  let res: (data: z.infer<typeof paramsValidator>) => void;
  const p = new Promise<z.infer<typeof paramsValidator>>((r) => {
    res = r;
  });
  const stopListening = await onOpenUrl(async (urls) => {
    for (const urlString of urls) {
      if (!urlString.includes("token=")) return;
      if (signal.aborted) return;

      const url = new URL(urlString);

      res(
        paramsValidator.parse({
          type: url.searchParams.get("type"),
          api_key: url.searchParams.get("api_key"),
          user_id: url.searchParams.get("user_id"),
        })
      );
    }
  });

  signal.onabort = () => {
    stopListening();
  };

  return {
    url: await createSessionRequestUrl(null, "desktop"),
    complete: () => p,
  };
}

async function processAuthData(data: z.infer<typeof paramsValidator>) {
  console.log({ data });
  identifyUser(data.user_id);
  trackEvent("user_signed_in", { platform: "desktop" });

  const existingAuth = await authStore.get();
  await authStore.set({
    secret: { api_key: data.api_key },
    user_id: data.user_id,
    intercom_hash: existingAuth?.intercom_hash ?? "",
    plan: null,
  });

  await commands.updateAuthPlan();
}
