import { cx } from "cva";
import { Button } from "@cap/ui-solid";
import { exit } from "@tauri-apps/plugin-process";

import { commands } from "../utils/tauri";
import {
  createEffect,
  createResource,
  Suspense,
  Switch,
  Match,
  createSignal,
} from "solid-js";
import { createTimer } from "@solid-primitives/timer";
import { getCurrentWindow } from "@tauri-apps/api/window";

export default function () {
  const [check, checkActions] = createResource(() =>
    commands.doPermissionsCheck()
  );

  createTimer(() => checkActions.refetch(), 100, setInterval);

  const [currentStep, setCurrentStep] = createSignal(0);

  const permissionsGranted = () => {
    const c = check.latest;
    if (c?.os === "macOS") {
      return c?.screenRecording && c?.camera && c?.microphone;
    }
    return false;
  };

  createEffect(() => {
    if (permissionsGranted()) {
      commands.openMainWindow();
      const window = getCurrentWindow();
      window.close();
    }
  });

  const steps = [
    { name: "Screen Recording", key: "screenRecording" },
    { name: "Camera", key: "camera" },
    { name: "Microphone", key: "microphone" },
  ] as const;

  const currentPermission = () => steps[currentStep()];

  const nextStep = () => {
    if (
      currentStep() < steps.length - 1 &&
      check.latest?.[currentPermission().key]
    ) {
      setCurrentStep(currentStep() + 1);
    }
  };

  return (
    <div class="flex flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400] flex-1 bg-gray-100 border rounded-lg border-gray-200">
      <div class="space-y-[0.2rem] flex-1">
        <IconCapLogo class="size-[3rem]" />
        <h1 class="text-[1rem] font-[700]">Permissions Required</h1>
        <p class="text-gray-400 text-[0.75rem]">
          Cap needs permissions to run properly. Microphone and camera
          permissions are required, but won't be used unless you choose a camera
          or microphone option.
        </p>
      </div>
      <Suspense fallback={<div class="w-full flex-1" />}>
        <Switch>
          <Match when={check.latest?.os === "macOS"}>
            {(latestCheck) => (
              <div class="flex flex-col items-start gap-4">
                <div class="flex flex-col items-start gap-1">
                  <span class="font-[500]">
                    {currentPermission().name} Permission
                  </span>
                  {latestCheck()[currentPermission().key] ? (
                    <span class="text-green-600">Granted</span>
                  ) : (
                    <Button
                      onClick={() => {
                        commands.openPermissionSettings({
                          macOS: currentPermission().key,
                        });
                      }}
                      disabled={check.latest?.[currentPermission().key]}
                    >
                      Open {currentPermission().name} Settings {}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </Match>
        </Switch>
      </Suspense>
      <div class="flex flex-row-reverse gap-2">
        <Button
          onClick={() => nextStep()}
          disabled={!check.latest?.[currentPermission().key]}
        >
          {currentStep() === steps.length - 1 ? "Continue" : "Next"}
        </Button>
        <Button variant="secondary" onClick={() => exit()}>
          Quit
        </Button>
      </div>
    </div>
  );
}
