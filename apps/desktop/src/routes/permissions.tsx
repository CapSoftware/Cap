import { Button } from "@cap/ui-solid";
import { exit } from "@tauri-apps/plugin-process";
import type { RouteSectionProps } from "@solidjs/router";
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

import Header from "../components/Header";

function isPermitted(status?: OSPermissionStatus): boolean {
  return status === "granted" || status === "notNeeded";
}

export default function (props: RouteSectionProps) {
  const steps = [
    { name: "Screen Recording", key: "screenRecording" as const },
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
      // We wait for the window to open as closing immediately after seems to cause an unlabeled crash
      commands.openMainWindow().then(() => {
        const window = getCurrentWindow();
        window.close();
      });
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
    <div class="rounded-[1.5rem] bg-gray-100 border border-gray-200 w-screen h-screen flex flex-col overflow-hidden">
      <Header />
      <Suspense
        fallback={
          <div class="w-full h-full flex items-center justify-center bg-gray-100">
            <div class="animate-spin">
              <IconCapLogo class="size-[4rem]" />
            </div>
          </div>
        }
      >
        <div class="flex flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400] flex-1 bg-gray-100">
          <div class="space-y-[0.375rem] flex-1">
            <IconCapLogo class="size-[3rem]" />
            <h1 class="text-[1rem] font-[700]">Permissions Required</h1>
            <p class="text-gray-400">Cap needs permissions to run properly.</p>
          </div>
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
                <Show
                  when={currentStepStatus() !== "denied"}
                  fallback={
                    <Button onClick={openSettings} class="w-full">
                      Open Settings
                    </Button>
                  }
                >
                  <Button
                    onClick={requestPermission}
                    disabled={currentStepStatus() !== "empty"}
                    class="w-full"
                  >
                    Grant {currentStep().name} Permission
                  </Button>
                </Show>
              </div>
            </Show>
          </Transition>
        </div>
      </Suspense>
    </div>
  );
}
