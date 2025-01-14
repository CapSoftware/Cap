import { Button } from "@cap/ui-solid";
import * as shell from "@tauri-apps/plugin-shell";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  action,
  redirect,
  useAction,
  useSubmission,
  useNavigate,
} from "@solidjs/router";
import { onMount, onCleanup } from "solid-js";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";

import callbackTemplate from "./callback.template";
import { authStore } from "~/store";
import { clientEnv } from "~/utils/env";
import { commands } from "~/utils/tauri";

const signInAction = action(async () => {
  let res: (url: URL) => void;

  try {
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

    // Stop any existing OAuth server first
    try {
      await invoke("plugin:oauth|stop");
    } catch (e) {
      // Ignore errors if no server is running
    }

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

    await shell.open(
      `${clientEnv.VITE_SERVER_URL}/api/desktop/session/request?port=${port}`
    );

    const url = await new Promise<URL>((r) => {
      res = r;
    });
    stopListening();

    const token = url.searchParams.get("token");
    const user_id = url.searchParams.get("user_id");
    const expires = Number(url.searchParams.get("expires"));
    if (!token || !expires || !user_id) {
      throw new Error("Invalid token or expires");
    }

    await authStore.set({
      token,
      user_id,
      expires,
      plan: { upgraded: false, last_checked: 0 },
    });

    return redirect("/");
  } catch (error) {
    console.error("Sign in failed:", error);
    await authStore.set();
    throw error;
  }
});

export default function Page() {
  const signIn = useAction(signInAction);
  const submission = useSubmission(signInAction);
  const navigate = useNavigate();

  const handleSkipAuth = async () => {
    // Use the Rust-side command which properly handles showing and focusing
    await commands.openMainWindow();
    // Close the current window after a small delay
    await new Promise((resolve) => setTimeout(resolve, 100));
    const currentWindow = await getCurrentWindow();
    await currentWindow.close();
  };

  // Listen for auth changes and redirect to signin if auth is cleared
  onMount(async () => {
    let unsubscribe: (() => void) | undefined;

    try {
      unsubscribe = await authStore.listen((auth) => {
        if (!auth) {
          // Replace the current route with signin
          navigate("/signin", { replace: true });
        }
      });
    } catch (error) {
      console.error("Failed to set up auth listener:", error);
    }

    // Clean up OAuth server on component unmount
    onCleanup(async () => {
      try {
        await invoke("plugin:oauth|stop");
      } catch (e) {
        // Ignore errors if no server is running
      }
      unsubscribe?.();
    });
  });

  return (
    <div class="flex flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400] flex-1 bg-gray-100">
      <div class="space-y-[0.375rem] flex-1">
        <IconCapLogo class="size-[3rem]" />
        <h1 class="text-[1rem] font-[700] text-black-transparent-80">
          Sign in to Cap
        </h1>
        <p class="text-gray-400">Beautiful screen recordings, owned by you.</p>
      </div>
      <div class="flex flex-col gap-2">
        {submission.pending ? (
          <Button variant="secondary" onClick={() => submission.clear()}>
            Cancel sign in
          </Button>
        ) : (
          <Button onClick={() => signIn()}>Sign in with your browser</Button>
        )}
        <span
          onClick={handleSkipAuth}
          class="text-center text-gray-400 hover:text-gray-500 underline cursor-pointer"
        >
          Skip auth
        </span>
      </div>
    </div>
  );
}
