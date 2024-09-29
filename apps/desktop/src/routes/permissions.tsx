import { Button } from "@cap/ui-solid";
import { exit } from "@tauri-apps/plugin-process";

import { commands, type OSPermissionStatus } from "~/utils/tauri";
import {
  createEffect,
  createResource,
  Suspense,
  createSignal,
  Show,
} from "solid-js";
import { createTimer } from "@solid-primitives/timer";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Transition } from "solid-transition-group";

function isPermitted(status?: OSPermissionStatus): boolean {
  return status === "granted" || status === "notNeeded";
}

export default function () {
  const steps = [
    { name: "Screen Recording", key: "screenRecording" as const },
    { name: "Camera", key: "camera" as const },
    { name: "Microphone", key: "microphone" as const },
    { name: "Accessibility", key: "accessibility" as const },
  ] as const;

  const [currentStepIndex, setCurrentStepIndex] = createSignal(0);
  const [initialCheck, setInitialCheck] = createSignal(true);
  const [check, checkActions] = createResource(() =>
    commands.doPermissionsCheck(initialCheck())
  );
  const currentStep = () => steps[currentStepIndex()];
  const currentStepStatus = () => check.latest?.[currentStep().key];

  createEffect(() => {
    if (!initialCheck()) {
      createTimer(() => checkActions.refetch(), 250, setInterval);
    }
  });

  createEffect(() => {
    const c = check.latest;
    const neededStep = steps.findIndex((step) => !isPermitted(c?.[step.key]));

    if (neededStep === -1) {
      // All permissions now granted
      commands.openMainWindow();
      const window = getCurrentWindow();
      window.close();
    } else {
      setCurrentStepIndex(neededStep);
    }
  });

  const requestPermission = () => {
    try {
      commands.requestPermission(currentStep().key);
    } catch (err) {
      console.error(`Error occurred while requesting permission: ${err}`);
    }
    setInitialCheck(false);
  };

  const openSettings = () => {
    commands.openPermissionSettings(currentStep().key);
    setInitialCheck(false);
  };

  return (
    <div class="flex flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400] flex-1 bg-gray-100 border rounded-lg border-gray-200 w-screen h-screen">
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
        <Transition
          mode="outin"
          enterActiveClass="transition-opacity"
          exitActiveClass="transition-opacity"
          enterClass="opacity-0"
          exitToClass="opacity-0"
        >
          <Show when={currentStep()} keyed>
            <div class="flex flex-col items-start gap-1">
              <h4 class="font-[500] text-[0.875rem]">
                {currentStep().name} Permission
              </h4>
              <div class="w-full flex gap-2">
                <Show
                  when={currentStepStatus() !== "denied"}
                  fallback={
                    <Button onClick={openSettings} class="flex-1">
                      Open Settings
                    </Button>
                  }
                >
                  <Button
                    onClick={requestPermission}
                    disabled={currentStepStatus() !== "empty"}
                    class="flex-1"
                  >
                    Grant
                  </Button>
                </Show>
                <Button
                  variant="secondary"
                  class="flex-1"
                  onClick={() => exit()}
                >
                  Quit
                </Button>
              </div>
            </div>
          </Show>
        </Transition>
      </Suspense>
    </div>
  );
}
