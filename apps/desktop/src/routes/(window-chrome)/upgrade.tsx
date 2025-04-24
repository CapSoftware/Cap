import { createRive } from "@aerofoil/rive-solid-canvas";
import { Button } from "@cap/ui-solid";
import { action, useAction } from "@solidjs/router";
import { createMutation } from "@tanstack/solid-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import * as shell from "@tauri-apps/plugin-shell";
import { Accessor, createSignal, onCleanup, onMount, Show } from "solid-js";
import { generalSettingsStore } from "~/store";
import { identifyUser, trackEvent } from "~/utils/analytics";
import { clientEnv } from "~/utils/env";
import { getProPlanId } from "~/utils/plans";
import { createLicenseQuery } from "~/utils/queries";
import { commands } from "~/utils/tauri";
import { apiClient, licenseApiClient, protectedHeaders } from "~/utils/web-api";
import PricingRive from "../../assets/rive/pricing.riv";
import { authStore } from "../../store";

import { Dialog, DialogContent, Input } from "../editor/ui";
import callbackTemplate from "./callback.template";

const signInAction = action(async (planType: "yearly" | "monthly") => {
  console.log("Starting sign in action");
  let res: (url: URL) => void;

  try {
    console.log("Setting up OAuth URL listener");
    const stopListening = await listen(
      "oauth://url",
      (data: { payload: string }) => {
        console.log("Received OAuth URL:", data.payload);
        if (!data.payload.includes("token")) {
          console.log("URL does not contain token, ignoring");
          return;
        }

        const urlObject = new URL(data.payload);
        res(urlObject);
      }
    );

    try {
      console.log("Stopping any existing OAuth server");
      await invoke("plugin:oauth|stop");
    } catch (e) {
      console.log("No existing OAuth server to stop");
    }

    console.log("Starting OAuth server");
    const port: string = await invoke("plugin:oauth|start", {
      config: {
        response: callbackTemplate,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
        cleanup: true,
      },
    });
    console.log("OAuth server started on port:", port);

    const platform =
      import.meta.env.VITE_ENVIRONMENT === "development" ? "web" : "desktop";
    console.log("Platform:", platform);

    const callbackUrl = new URL(
      `/api/desktop/session/request`,
      clientEnv.VITE_SERVER_URL
    );
    callbackUrl.searchParams.set("port", port);
    callbackUrl.searchParams.set("platform", platform);
    console.log("Callback URL:", callbackUrl.toString());

    console.log("Hiding upgrade window");
    const currentUpgradeWindow = await Window.getByLabel("upgrade");
    if (currentUpgradeWindow) {
      await currentUpgradeWindow.minimize();
    }

    console.log("Opening auth URL in browser");
    await shell.open(callbackUrl.toString());

    console.log("Waiting for OAuth callback");
    const url = await new Promise<URL>((r) => {
      res = r;
    });
    console.log("Received OAuth callback");
    stopListening();

    const isDevMode = import.meta.env.VITE_ENVIRONMENT === "development";
    if (!isDevMode) {
      console.log("Not in dev mode, returning");
      return;
    }

    const token = url.searchParams.get("token");
    const user_id = url.searchParams.get("user_id");
    const expires = Number(url.searchParams.get("expires"));
    if (!token || !expires || !user_id) {
      console.error("Missing required auth params");
      throw new Error("Invalid token or expires");
    }
    console.log("Received valid auth params");

    const existingAuth = await authStore.get();
    console.log("Setting auth store");
    await authStore.set({
      token,
      user_id,
      expires,
      intercom_hash: existingAuth?.intercom_hash ?? "",
      plan: {
        upgraded: false,
        last_checked: 0,
        manual: existingAuth?.plan?.manual ?? false,
      },
    });

    console.log("Identifying user in analytics");
    identifyUser(user_id);
    console.log("Tracking sign in event");
    trackEvent("user_signed_in", { platform: "desktop" });

    console.log("Reopening upgrade window");
    await commands.showWindow("Upgrade");

    console.log("Waiting for window to be ready");
    await new Promise((resolve) => setTimeout(resolve, 500));

    console.log("Getting upgrade window reference");
    const focusedUpgradeWindow = await Window.getByLabel("upgrade");
    if (focusedUpgradeWindow) {
      try {
        console.log("Setting focus on upgrade window");
        await focusedUpgradeWindow.show();
        await focusedUpgradeWindow.setFocus();
      } catch (e) {
        console.error("Failed to focus upgrade window:", e);
      }
    }

    console.log("Getting checkout URL");
    const planId = getProPlanId(planType);
    const response = await apiClient.desktop.getProSubscribeURL({
      body: { priceId: planId },
      headers: await protectedHeaders(),
    });

    if (response.status === 200) {
      console.log("Opening checkout URL in external browser");
      commands.openExternalLink(response.body.url);
      console.log("Minimizing upgrade window");
      const window = await Window.getByLabel("upgrade");
      if (window) {
        await window.minimize();
      }
    }
  } catch (error) {
    console.error("Sign in failed:", error);
    await authStore.set();
    throw error;
  }
});

const proFeatures = [
  "Commercial License Included",
  "Unlimited cloud storage & Shareable links",
  "Connect custom S3 storage bucket",
  "Advanced teams features",
  "Unlimited views",
  "Password protected videos",
  "Advanced analytics",
  "Priority support",
];

import { RuntimeLoader } from "@rive-app/canvas";
import riveWASMResource from "@rive-app/canvas/rive.wasm?url";

RuntimeLoader.setWasmUrl(riveWASMResource);

export default function Page() {
  const [isProAnnual, setIsProAnnual] = createSignal(true);
  const [isCommercialAnnual, setIsCommercialAnnual] = createSignal(true);
  const [upgradeComplete, setUpgradeComplete] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const signIn = useAction(signInAction);
  const license = createLicenseQuery();
  const [openLicenseDialog, setOpenLicenseDialog] = createSignal(false);

  const resetLicense = createMutation(() => ({
    mutationFn: async () => {
      const generalSettings = await generalSettingsStore.get();
      if (
        !generalSettings?.instanceId ||
        !license.data ||
        license.data.type !== "commercial"
      ) {
        throw new Error("No instance ID or valid commercial license found");
      }

      const resp = await licenseApiClient.activateCommercialLicense({
        headers: {
          licensekey: license.data.licenseKey,
          instanceid: generalSettings.instanceId,
        },
        body: { reset: true },
      });

      if (resp.status !== 200) {
        if (
          typeof resp.body === "object" &&
          resp.body &&
          "message" in resp.body
        )
          throw resp.body.message;
        throw new Error((resp.body as any).toString());
      }
    },
    onSuccess: async () => {
      await generalSettingsStore.set({
        commercialLicense: undefined,
      });
      license.refetch();
    },
  }));

  const openCheckoutInExternalBrowser = async () => {
    console.log("Opening checkout in external browser");
    setLoading(true);

    try {
      const auth = await authStore.get();
      console.log("Auth status:", auth ? "authenticated" : "not authenticated");

      if (!auth) {
        console.log("No auth found, starting sign in flow");
        await signIn(isProAnnual() ? "yearly" : "monthly");
        return;
      }

      const planId = getProPlanId(isProAnnual() ? "yearly" : "monthly");
      console.log("Getting checkout URL for plan:", planId);
      const response = await apiClient.desktop.getProSubscribeURL({
        body: { priceId: planId },
        headers: await protectedHeaders(),
      });

      if (response.status === 200) {
        console.log("Opening checkout URL in external browser");
        commands.openExternalLink(response.body.url);
        console.log("Minimizing upgrade window");
        const window = await Window.getByLabel("upgrade");
        if (window) {
          await window.minimize();
        }
      } else {
        console.error("Failed to get checkout URL, status:", response.status);
      }
    } catch (error) {
      console.error("Error getting checkout URL:", error);
    } finally {
      setLoading(false);
    }
  };

  const openCommercialCheckout = createMutation(() => ({
    mutationFn: async () => {
      const resp = await licenseApiClient.createCommercialCheckoutUrl({
        body: { type: isCommercialAnnual() ? "yearly" : "lifetime" },
      });

      if (resp.status === 200) {
        console.log("Opening checkout URL in external browser");
        commands.openExternalLink(resp.body.url);
        console.log("Minimizing upgrade window");
        const window = await Window.getByLabel("upgrade");
        if (window) {
          await window.minimize();
        }
      } else {
        throw resp.body;
      }
    },
  }));

  onMount(async () => {
    console.log("Component mounted");
    const unsubscribeDeepLink = await onOpenUrl(async (urls) => {
      console.log("Deep link received:", urls);
      const isDevMode = import.meta.env.VITE_ENVIRONMENT === "development";
      if (isDevMode) {
        console.log("In dev mode, ignoring deep link");
        return;
      }

      for (const url of urls) {
        if (!url.includes("token=")) {
          console.log("URL does not contain token, skipping");
          return;
        }

        console.log("Processing auth URL");
        const urlObject = new URL(url);
        const token = urlObject.searchParams.get("token");
        const user_id = urlObject.searchParams.get("user_id");
        const expires = Number(urlObject.searchParams.get("expires"));

        if (!token || !expires || !user_id) {
          console.error("Invalid signin params");
          throw new Error("Invalid signin params");
        }

        console.log("Setting auth store with new credentials");
        const existingAuth = await authStore.get();
        await authStore.set({
          token,
          user_id,
          expires,
          intercom_hash: existingAuth?.intercom_hash ?? "",
          plan: {
            upgraded: false,
            last_checked: 0,
            manual: existingAuth?.plan?.manual ?? false,
          },
        });

        console.log("Identifying user in analytics");
        identifyUser(user_id);
        console.log("Tracking sign in event");
        trackEvent("user_signed_in", { platform: "desktop" });

        console.log("Reopening upgrade window");
        await commands.showWindow("Upgrade");

        console.log("Waiting for window to be ready");
        await new Promise((resolve) => setTimeout(resolve, 500));

        console.log("Getting upgrade window reference");
        const upgradeWindow = await Window.getByLabel("upgrade");
        if (upgradeWindow) {
          try {
            console.log("Setting focus on upgrade window");
            await upgradeWindow.show();
            await upgradeWindow.setFocus();
          } catch (e) {
            console.error("Failed to focus upgrade window:", e);
          }
        }

        console.log("Getting checkout URL");
        const planId = getProPlanId(isProAnnual() ? "yearly" : "monthly");
        const response = await apiClient.desktop.getProSubscribeURL({
          body: { priceId: planId },
          headers: await protectedHeaders(),
        });

        if (response.status === 200) {
          console.log("Opening checkout URL in external browser");
          commands.openExternalLink(response.body.url);
          console.log("Minimizing upgrade window");
          if (upgradeWindow) {
            await upgradeWindow.minimize();
          }
        }
      }
    });

    onCleanup(() => {
      console.log("Cleaning up deep link listener");
      unsubscribeDeepLink();
    });

    console.log("Setting up upgrade status check interval");
    const interval = setInterval(async () => {
      console.log("Checking upgrade status");
      const result = await commands.checkUpgradedAndUpdate();
      if (result) {
        console.log("Upgrade complete");
        setUpgradeComplete(true);
      }
    }, 5000);
    onCleanup(() => {
      console.log("Cleaning up upgrade status check interval");
      clearInterval(interval);
    });
  });

  const { rive: CommercialRive, RiveComponent: Commercial } = createRive(
    () => ({
      src: PricingRive,
      autoplay: true,
      artboard: "commercial",
      animations: ["card-stack"],
    })
  );

  const { rive: ProRive, RiveComponent: Pro } = createRive(() => ({
    src: PricingRive,
    autoplay: true,
    artboard: "pro",
    animations: ["items-coming-in"],
  }));

  return (
    <div class="flex relative flex-col justify-center items-center p-5 mx-auto w-full h-full">
      {upgradeComplete() && (
        <div class="flex justify-center items-center h-full bg-gray-800 bg-opacity-75">
          <div class="relative z-10 p-6 text-center bg-white rounded-lg shadow-lg">
            <h2 class="mb-4 text-2xl font-bold">Upgrade complete</h2>
            <p class="mb-4 text-sm text-[--text-tertiary]">
              You can now close this window - thank you for upgrading!
            </p>
            <Button
              onClick={() => {
                console.log("Closing window after upgrade");
                const window = getCurrentWindow();
                window.close();
              }}
              variant="primary"
              size="lg"
            >
              Close window
            </Button>
          </div>
        </div>
      )}
      {!upgradeComplete() && (
        <>
          {license.data?.type === "commercial" ? (
            <div class="bg-[--gray-50] dark:bg-[--gray-900] rounded-xl shadow-sm border border-gray-200 dark:border-[--gray-700] w-full">
              <div class="space-y-6">
                <div class="border-b border-gray-200 dark:border-[--gray-700] pb-6">
                  <h3 class="text-2xl font-semibold tracking-tight text-[--text-primary]">
                    Your Commercial License
                  </h3>
                  <p class="mt-2 text-sm text-[--text-tertiary]">
                    License details for Cap commercial use
                  </p>
                </div>

                <div class="space-y-6">
                  <div class="space-y-2">
                    <label class="text-sm font-medium text-[--text-primary]">
                      License Key
                    </label>
                    <pre class="w-full p-3 bg-gray-50 dark:bg-[--gray-800] rounded-lg border border-gray-200 dark:border-[--gray-700] font-mono text-sm text-[--text-secondary] break-all whitespace-pre-wrap">
                      {license.data.licenseKey}
                    </pre>
                  </div>

                  <Show when={license.data.expiryDate}>
                    {(expiryDate) => (
                      <div class="space-y-2">
                        <label class="text-sm font-medium text-[--text-primary]">
                          Expiration Date
                        </label>
                        <div class="w-full p-3 bg-gray-50 dark:bg-[--gray-800] rounded-lg border border-gray-200 dark:border-[--gray-700] text-sm text-[--text-secondary]">
                          {new Date(expiryDate()).toLocaleDateString(
                            undefined,
                            {
                              year: "numeric",
                              month: "long",
                              day: "numeric",
                            }
                          )}
                        </div>
                      </div>
                    )}
                  </Show>

                  <div class="pt-4 border-t border-gray-200 dark:border-[--gray-700]">
                    <Button
                      variant="destructive"
                      class="mx-auto w-fit"
                      disabled={resetLicense.isPending}
                      onClick={() => {
                        resetLicense.mutate();
                      }}
                    >
                      {resetLicense.isPending
                        ? "Detaching..."
                        : "Detach License"}
                    </Button>
                    <p class="mt-2 text-xs text-[--text-tertiary]">
                      This will remove the license key from this device.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div class="text-center">
                <h1 class="text-4xl md:text-4xl mb-6 tracking-[-.05em] font-medium text-[--text-primary]">
                  Early Adopter Pricing
                </h1>
              </div>
              <div class="flex gap-4 w-full">
                <div
                  onMouseEnter={() => {
                    const riveInstance = CommercialRive();
                    if (riveInstance) {
                      // Stop any current animations first
                      riveInstance.stop();
                      // Play the enter animation
                      riveInstance.play("cards");
                    }
                  }}
                  onMouseLeave={() => {
                    const riveInstance = CommercialRive();
                    if (riveInstance) {
                      // Stop any current animations first
                      riveInstance.stop();
                      // Play the leave animation
                      riveInstance.play("card-stack");
                    }
                  }}
                  class="flex flex-col flex-1 justify-between p-3 h-[700px ] bg-gray-200 rounded-2xl border border-gray-200 shadow-sm text-card-foreground md:p-3"
                >
                  <div class="space-y-5">
                    <div class="flex flex-col gap-6 items-center">
                      <Commercial class="w-[250px]" />
                      <div class="space-y-1 text-center">
                        <h3 class="text-2xl font-medium leading-5 tracking-tight text-[--text-primary]">
                          Commercial License
                        </h3>
                        <p class="mt-2 text-sm text-[--text-tertiary]">
                          License details for Cap commercial use
                        </p>
                      </div>
                      <div class="flex flex-col justify-center items-center">
                        <h3 class="text-4xl leading-6 text-[--text-primary]">
                          {isCommercialAnnual() ? "$29" : "$58"}
                          <span class="text-gray-400 text-[16px]">.00 /</span>
                        </h3>
                        {isCommercialAnnual() && (
                          <p class="text-[16px] font-medium text-gray-400">
                            billed annually
                          </p>
                        )}
                        {!isCommercialAnnual() && (
                          <p class="text-[16px] font-medium text-gray-400">
                            one-time payment
                          </p>
                        )}
                      </div>
                      <div
                        onClick={() => setIsCommercialAnnual((v) => !v)}
                        class="px-3 py-2 text-center bg-gray-300 rounded-full border border-transparent transition-all duration-300 cursor-pointer hover:border-gray-400"
                      >
                        <p class="text-xs text-gray-500">
                          Switch to{" "}
                          {isCommercialAnnual() ? "lifetime" : "yearly"}:{" "}
                          <span class="font-medium">
                            {isCommercialAnnual() ? "$58" : "$29"}
                          </span>
                        </p>
                      </div>
                      <ul class="flex flex-col gap-2 justify-center list-none">
                        {[
                          "Commercial Use of Cap Recorder + Editor",
                          "Community Support",
                          "Local-only features",
                          "Perpetual license option",
                        ].map((feature) => (
                          <li class="flex justify-start items-center">
                            <div class="flex justify-center items-center p-0 m-0 w-6 h-6">
                              <IconLucideCheck class="w-4 h-4 text-[--text-primary]" />
                            </div>
                            <span class="ml-1 text-[0.9rem] text-[--text-primary]">
                              {feature}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <ActivateLicenseDialog
                    open={openLicenseDialog}
                    onOpenChange={setOpenLicenseDialog}
                  />
                  <div class="flex flex-col gap-4 items-center">
                    <button
                      onClick={() => openCommercialCheckout.mutate()}
                      disabled={openCommercialCheckout.isPending}
                      class="flex items-center justify-center transition-opacity duration-200 rounded-full bg-[--gray-500] hover:opacity-90 disabled:bg-[--gray-400] font-medium text-lg px-6 h-12 w-full no-underline text-gray-50"
                    >
                      {openCommercialCheckout.isPending
                        ? "Loading..."
                        : "Purchase License"}
                    </button>
                    <p
                      onClick={() => setOpenLicenseDialog(true)}
                      class="mb-2 text-sm text-gray-400 transition-colors cursor-pointer hover:text-gray-500"
                    >
                      Already have a license key?
                    </p>
                  </div>
                </div>

                {/* Cap Pro */}
                <div
                  onMouseEnter={() => {
                    const riveInstance = ProRive();
                    if (riveInstance) {
                      // Stop any current animations first
                      riveInstance.stop();
                      // Play the enter animation
                      riveInstance.play("items-coming-out");
                    }
                  }}
                  onMouseLeave={() => {
                    const riveInstance = ProRive();
                    if (riveInstance) {
                      // Stop any current animations first
                      riveInstance.stop();
                      // Play the leave animation
                      riveInstance.play("items-coming-in");
                    }
                  }}
                  class="flex-grow p-3 h-[700px] flex-1 dark:bg-solid-white bg-gray-500 rounded-2xl border shadow-sm text-card-foreground md:p-3 border-gray-200 dark:border-[--gray-700]"
                >
                  <div class="flex flex-col justify-between space-y-5 h-full">
                    <div class="flex flex-col gap-6 items-center px-6">
                      <Pro class="w-[250px]" />
                      <div class="space-y-1 text-center">
                        <h3 class="text-2xl font-medium tracking-tight leading-5 text-gray-50">
                          Cap Pro
                        </h3>
                        <p class="text-[0.875rem] text-gray-400">
                          For professional use and teams.
                        </p>
                      </div>
                      <div class="flex flex-col justify-center items-center">
                        <h3 class="text-4xl leading-6 text-gray-50">
                          {isProAnnual() ? "$6" : "$9"}
                          <span class="text-gray-400 text-[16px]">.00 /</span>
                        </h3>
                        {isProAnnual() && (
                          <p class="text-[16px] font-medium text-gray-400">
                            per user, billed annually
                          </p>
                        )}
                        {!isProAnnual() && (
                          <p class="text-[16px] font-medium text-gray-400">
                            per user, billed monthly
                          </p>
                        )}
                      </div>
                      <div
                        onClick={() => setIsProAnnual((v) => !v)}
                        class="px-3 py-2 text-center bg-blue-300 rounded-full border border-transparent transition-all duration-300 cursor-pointer hover:border-blue-400"
                      >
                        <p class="text-xs text-solid-white">
                          Switch to {isProAnnual() ? "monthly" : "yearly"}:{" "}
                          <span class="font-medium">
                            {isProAnnual()
                              ? "$9 per user, billed monthly"
                              : "$6 per user, billed annually"}
                          </span>
                        </p>
                      </div>
                      <ul class="flex flex-col gap-2 justify-center list-none">
                        {proFeatures.map((feature) => (
                          <li class="flex justify-start items-center dark:text-gray-50 text-solid-white">
                            <div class="size-4 m-0 p-0 flex items-center dark:border-[--gray-500] justify-center">
                              <IconLucideCheck class="size-4" />
                            </div>
                            <span class="ml-2 text-[0.9rem]">{feature}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <Button
                      variant="primary"
                      class="!rounded-full !text-lg w-full mx-auto"
                      onClick={openCheckoutInExternalBrowser}
                    >
                      {loading() ? "Loading..." : "Upgrade to Cap Pro"}
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

interface Props {
  open: Accessor<boolean>;
  onOpenChange: (open: boolean) => void;
}

const ActivateLicenseDialog = ({ open, onOpenChange }: Props) => {
  const [licenseKey, setLicenseKey] = createSignal("");

  const activateLicenseKey = createMutation(() => ({
    mutationFn: async (vars: { licenseKey: string }) => {
      const generalSettings = await generalSettingsStore.get();
      if (!generalSettings?.instanceId) {
        throw new Error("No instance ID found");
      }
      const resp = await licenseApiClient.activateCommercialLicense({
        headers: {
          licensekey: vars.licenseKey,
          instanceid: generalSettings.instanceId,
        },
        body: { reset: false },
      });

      if (resp.status === 200)
        return { ...resp.body, licenseKey: vars.licenseKey };
      if (typeof resp.body === "object" && resp.body && "message" in resp.body)
        throw resp.body.message;
      throw new Error((resp.body as any).toString());
    },
    onSuccess: async (value) => {
      await generalSettingsStore.set({
        commercialLicense: {
          activatedOn: Date.now(),
          expiryDate: value.expiryDate ?? null,
          refresh: value.refresh,
          licenseKey: value.licenseKey,
        },
      });
    },
  }));
  return (
    <Dialog.Root open={open()} onOpenChange={onOpenChange}>
      <DialogContent
        title="Activate License"
        confirm={
          <Dialog.ConfirmButton
            disabled={activateLicenseKey.isPending}
            onClick={() =>
              activateLicenseKey.mutate({
                licenseKey: licenseKey(),
              })
            }
          >
            Activate
          </Dialog.ConfirmButton>
        }
      >
        <Input
          class="mt-2"
          placeholder="Enter license key..."
          value={licenseKey()}
          onInput={(e) => setLicenseKey(e.currentTarget.value)}
        />
      </DialogContent>
    </Dialog.Root>
  );
};
