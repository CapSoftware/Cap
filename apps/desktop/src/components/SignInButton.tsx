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
import { createSignInMutation } from "~/utils/auth";

export function SignInButton(
  props: Omit<ComponentProps<typeof Button>, "onClick">
) {
  const signIn = createSignInMutation();

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
