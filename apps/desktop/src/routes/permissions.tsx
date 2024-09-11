import { cx } from "cva";
import { Button } from "@cap/ui-solid";
import { exit } from "@tauri-apps/plugin-process";

import { commands } from "../utils/tauri";
import { createEffect, createResource, Suspense, Switch } from "solid-js";
import { Match } from "solid-js";
import { createTimer } from "@solid-primitives/timer";
import { getCurrentWindow } from "@tauri-apps/api/window";

export default function () {
  const [check, checkActions] = createResource(() =>
    commands.doPermissionsCheck()
  );

  createTimer(() => checkActions.refetch(), 100, setInterval);

  const permissionsGranted = () => {
    const c = check.latest;
    if (c?.os === "macOS") return c?.screenRecording;
  };

  createEffect(() => {
    if (permissionsGranted()) {
      commands.openMainWindow();
      const window = getCurrentWindow();
      window.close();
    }
  });

  return (
    <div class="rounded-lg bg-gray-50 w-screen h-screen text-sm flex flex-col divide-y divide-gray-200">
      <div
        class={cx(
          "pl-[1rem] flex flex-row items-center font-[500] h-[2.9rem] shrink-0"
        )}
        data-tauri-drag-region
      >
        <span data-tauri-drag-region>Recording Permissions</span>
      </div>
      <Suspense fallback={<div class="w-full flex-1 bg-gray-100" />}>
        <Switch>
          <Match
            when={(() => {
              const c = check.latest;
              if (c?.os === "macOS") return c;
            })()}
          >
            {(check) => (
              <div class="flex flex-col items-center justify-center gap-4 flex-1">
                <div class="flex flex-col items-center gap-2">
                  <span>Screen Recording Permission</span>
                  {check().screenRecording ? (
                    <span>Granted</span>
                  ) : (
                    <Button
                      onClick={() => {
                        commands.openPermissionSettings({
                          macOS: "screenRecording",
                        });
                      }}
                    >
                      Open Settings
                    </Button>
                  )}
                </div>
                {/*<div class="flex flex-col items-center gap-2">
        <span>Accessibility Permission</span>
        <Button
          onClick={() => {
            commands.openPermissionSettings({ macOS: "accessibility" });
          }}
        >
          Open Settings
        </Button>
      </div>*/}
              </div>
            )}
          </Match>
        </Switch>
      </Suspense>
      <div class="flex flex-row-reverse p-2 gap-2">
        <Button disabled={!permissionsGranted()}>
          {permissionsGranted() ? "Continue" : "Waiting"}
        </Button>
        <Button variant="secondary" onClick={() => exit()}>
          Quit
        </Button>
      </div>
    </div>
  );
}
