import { Button } from "@cap/ui-solid";
import type { RouteSectionProps } from "@solidjs/router";
import { commands, OSPermission, type OSPermissionStatus } from "~/utils/tauri";
import {
  createEffect,
  createResource,
  Suspense,
  createSignal,
  Show,
  For,
  startTransition,
} from "solid-js";
import { createTimer } from "@solid-primitives/timer";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Transition } from "solid-transition-group";

import Header from "../../components/Header";

function isPermitted(status?: OSPermissionStatus): boolean {
  return status === "granted" || status === "notNeeded";
}

const permissions = [
  {
    name: "Screen Recording",
    key: "screenRecording" as const,
    description: "Cap needs access to record your screen",
  },
  {
    name: "Accessibility",
    key: "accessibility" as const,
    description:
      "Cap records your mouse and keyboard activity to be used in your Caps",
  },
] as const;

export default function () {
  const [initialCheck, setInitialCheck] = createSignal(true);
  const [check, checkActions] = createResource(() =>
    commands.doPermissionsCheck(initialCheck())
  );

  createEffect(() => {
    if (!initialCheck()) {
      createTimer(
        () => startTransition(() => checkActions.refetch()),
        250,
        setInterval
      );
    }
  });

  const requestPermission = (permission: OSPermission) => {
    console.log({ permission });
    try {
      commands.requestPermission(permission);
    } catch (err) {
      console.error(`Error occurred while requesting permission: ${err}`);
    }
    setInitialCheck(false);
  };

  const openSettings = (permission: OSPermission) => {
    commands.openPermissionSettings(permission);
    setInitialCheck(false);
  };

  return (
    <div class="flex flex-col p-[1rem] text-[0.875rem] font-[400] flex-1 bg-gray-100 justify-between">
      <div class="flex flex-col items-center">
        <IconCapLogo class="size-16 mb-1" />
        <h1 class="text-[1rem] font-[700] mb-0.5">Permissions Required</h1>
        <p class="text-gray-400">Cap needs permissions to run properly.</p>
      </div>

      <ul class="flex flex-col gap-4">
        <For each={permissions}>
          {(permission) => {
            const permissionCheck = () => check()?.[permission.key];

            return (
              <Show when={permissionCheck() !== "notNeeded"}>
                <li class="flex flex-row items-center gap-4">
                  <div class="flex flex-col flex-[2]">
                    <span class="font-[500] text-[0.875rem]">
                      {permission.name} Permission
                    </span>
                    <span class="text-gray-400">{permission.description}</span>
                  </div>
                  <Button
                    class="flex-1 shrink-0"
                    onClick={() =>
                      permissionCheck() !== "denied"
                        ? requestPermission(permission.key)
                        : openSettings(permission.key)
                    }
                    disabled={isPermitted(permissionCheck())}
                  >
                    {permissionCheck() === "granted"
                      ? "Granted"
                      : permissionCheck() !== "denied"
                      ? "Grant Permission"
                      : "Request Permission"}
                  </Button>
                </li>
              </Show>
            );
          }}
        </For>
      </ul>

      <Button
        disabled={
          permissions.find((p) => !isPermitted(check()?.[p.key])) !== undefined
        }
        onClick={() => {
          startTransition(() => {
            commands.openMainWindow().then(() => {
              getCurrentWindow().close();
            });
          });
        }}
      >
        Continue to Cap
      </Button>
    </div>
  );
}
