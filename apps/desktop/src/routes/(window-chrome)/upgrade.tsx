import { createSignal, onCleanup, onMount } from "solid-js";
import { Button } from "@cap/ui-solid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as shell from "@tauri-apps/plugin-shell";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  action,
  useAction,
  useSubmission,
  redirect,
  useNavigate,
} from "@solidjs/router";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { Window } from "@tauri-apps/api/window";

import { authStore } from "../../store";
import { getProPlanId } from "~/utils/plans";
import { commands } from "~/utils/tauri";
import { apiClient, protectedHeaders } from "~/utils/web-api";
import { clientEnv } from "~/utils/env";
import { identifyUser, trackEvent } from "~/utils/analytics";
import callbackTemplate from "./callback.template";
import { Input } from "../editor/ui";
import { licenseApiClient } from "~/utils/web-api";
import { generalSettingsStore } from "~/store";
import { createMutation } from "@tanstack/solid-query";
import { ClientInferResponseBody } from "@ts-rest/core";
import { licenseContract } from "@cap/web-api-contract";
import { createLicenseQuery } from "~/utils/queries";

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
      `${clientEnv.VITE_SERVER_URL}/api/desktop/session/request`
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

export default function Page() {
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

  const [isAnnual, setIsAnnual] = createSignal(true);
  const [isCommercialAnnual, setIsCommercialAnnual] = createSignal(true);
  const [upgradeComplete, setUpgradeComplete] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [isAuthenticated, setIsAuthenticated] = createSignal(true);
  const [licenseKey, setLicenseKey] = createSignal("");
  const signIn = useAction(signInAction);
  const submission = useSubmission(signInAction);
  const license = createLicenseQuery();
  const navigate = useNavigate();

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

  const togglePricing = () => {
    console.log("Toggling pricing plan");
    setIsAnnual(!isAnnual());
  };

  const toggleCommercialPricing = () => {
    console.log("Toggling commercial pricing plan");
    setIsCommercialAnnual(!isCommercialAnnual());
  };

  const openCheckoutInExternalBrowser = async () => {
    console.log("Opening checkout in external browser");
    setLoading(true);

    try {
      const auth = await authStore.get();
      console.log("Auth status:", auth ? "authenticated" : "not authenticated");

      if (!auth) {
        console.log("No auth found, starting sign in flow");
        await signIn(isAnnual() ? "yearly" : "monthly");
        return;
      }

      const planId = getProPlanId(isAnnual() ? "yearly" : "monthly");
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
          expiryDate: value.expiryDate,
          refresh: value.refresh,
          licenseKey: value.licenseKey,
        },
      });
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
        const planId = getProPlanId(isAnnual() ? "yearly" : "monthly");
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

  return (
    <div class="p-5 w-full h-full mx-auto relative items-center justify-center flex flex-col">
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
            <div class="bg-[--gray-50] dark:bg-[--gray-900] rounded-xl shadow-sm border border-gray-200 dark:border-[--gray-700] p-8 w-full">
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

                  <div class="space-y-2">
                    <label class="text-sm font-medium text-[--text-primary]">
                      Expiration Date
                    </label>
                    <div class="w-full p-3 bg-gray-50 dark:bg-[--gray-800] rounded-lg border border-gray-200 dark:border-[--gray-700] text-sm text-[--text-secondary]">
                      {new Date(license.data.expiryDate).toLocaleDateString(
                        undefined,
                        {
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                        }
                      )}
                    </div>
                  </div>

                  <div class="pt-4 border-t border-gray-200 dark:border-[--gray-700]">
                    <Button
                      variant="destructive"
                      class="w-fit mx-auto"
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
                <h1 class="text-4xl md:text-4xl mb-3 tracking-[-.05em] font-medium text-[--text-primary]">
                  Early Adopter Pricing
                </h1>
              </div>
              <div class="flex gap-4 w-full">
                <div class="flex-grow p-3 bg-gray-200 rounded-xl border shadow-sm text-card-foreground md:p-3 border-gray-300/20">
                  <div class="space-y-3">
                    <div class="flex flex-col space-y-1.5 pt-6 px-6">
                      <h3 class="text-2xl font-medium tracking-tight text-[--text-primary]">
                        Commercial License
                      </h3>
                      <p class="text-[0.875rem] leading-[1.25rem] text-[--text-primary]">
                        For professional use without cloud features.
                      </p>
                      <div>
                        <div class="flex items-center space-x-3">
                          <h3 class="text-4xl text-[--text-primary]">
                            {isCommercialAnnual() ? "$29" : "$58"}
                          </h3>
                          <div>
                            {isCommercialAnnual() && (
                              <p class="text-sm font-medium text-[--text-primary]">
                                billed annually
                              </p>
                            )}
                            {!isCommercialAnnual() && (
                              <p class="text-sm font-medium text-[--text-primary]">
                                one-time payment
                              </p>
                            )}
                            {isCommercialAnnual() && (
                              <p class="text-sm text-[--text-primary]">
                                or, $58 one-time payment.
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div class="px-3 md:px-8">
                      <div class="flex items-center pt-4 pb-1 mt-3 border-t-2 border-[--black-transparent-20]">
                        <span class="mr-2 text-xs text-[--text-primary]">
                          Switch to{" "}
                          {isCommercialAnnual() ? "lifetime" : "yearly"}
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={!isCommercialAnnual()}
                          data-state={
                            isCommercialAnnual() ? "unchecked" : "checked"
                          }
                          value={!isCommercialAnnual() ? "on" : "off"}
                          class="peer inline-flex h-4 w-8 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-[--gray-400] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={toggleCommercialPricing}
                        >
                          <span
                            data-state={
                              isCommercialAnnual() ? "unchecked" : "checked"
                            }
                            class={`pointer-events-none block h-4 w-4 rounded-full bg-gray-50 shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 border-2 ${
                              !isCommercialAnnual()
                                ? "border-gray-400"
                                : "border-gray-300"
                            }`}
                          />
                        </button>
                      </div>
                    </div>
                    <div class="px-6 pt-0 pb-4">
                      <button
                        onClick={() => openCommercialCheckout.mutate()}
                        disabled={openCommercialCheckout.isPending}
                        class="flex items-center justify-center transition-opacity duration-200 rounded-full bg-[--gray-500] hover:opacity-90 disabled:bg-[--gray-400] font-medium text-lg px-6 h-12 w-full no-underline text-gray-50"
                      >
                        {openCommercialCheckout.isPending
                          ? "Loading..."
                          : "Purchase License"}
                      </button>
                    </div>
                    <div class="px-6 pt-0">
                      <p class="text-[--text-primary] text-sm mb-2">
                        Already have a license key?
                      </p>
                      <div class="h-[76px]">
                        <Input
                          placeholder="Enter license key"
                          value={licenseKey()}
                          onInput={(e) => setLicenseKey(e.currentTarget.value)}
                        />
                        <Button
                          class="mt-2 w-full relative"
                          disabled={activateLicenseKey.isPending}
                          onClick={() =>
                            activateLicenseKey.mutate({
                              licenseKey: licenseKey(),
                            })
                          }
                        >
                          <div class="w-full flex justify-center">
                            Activate License
                          </div>
                        </Button>
                      </div>
                    </div>
                    <div class="flex items-center px-6 pt-0 pb-6">
                      <div class="space-y-6">
                        <div>
                          <ul class="p-0 space-y-3 list-none">
                            {[
                              "Commercial Use of Cap Recorder + Editor",
                              "Community Support",
                              "Local-only features",
                              "Perpetual license option",
                            ].map((feature) => (
                              <li class="flex justify-start items-center">
                                <div class="w-6 h-6 m-0 p-0 flex items-center border-[2px] border-[--gray-500] justify-center rounded-full">
                                  <IconLucideCheck class="w-4 h-4 text-[--text-primary]" />
                                </div>
                                <span class="ml-2 text-[0.9rem] text-[--text-primary]">
                                  {feature}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="flex-grow p-3 bg-blue-300 rounded-xl border shadow-sm text-card-foreground md:p-3 border-blue-500/20">
                  <div class="space-y-3">
                    <div class="flex flex-col space-y-1.5 pt-6 px-6">
                      <h3 class="text-2xl font-medium tracking-tight text-gray-50 dark:text-[--text-primary]">
                        Cap Pro
                      </h3>
                      <p class="text-[0.875rem] leading-[1.25rem] text-gray-50 dark:text-[--text-primary]">
                        For professional use and teams.
                      </p>
                      <div>
                        <div class="flex items-center space-x-3">
                          <h3 class="text-4xl text-gray-50 dark:text-[--text-primary]">
                            {isAnnual() ? "$6/mo" : "$9/mo"}
                          </h3>
                          <div>
                            <p class="text-sm font-medium text-gray-50 dark:text-[--text-primary]">
                              {isAnnual()
                                ? "per user, billed annually."
                                : "per user, billed monthly."}
                            </p>
                            {isAnnual() && (
                              <p class="text-sm text-gray-50 dark:text-[--text-primary]">
                                or, $9/month, billed monthly.
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div class="px-3 mt-3 md:px-8">
                      <div class="flex items-center pt-4 pb-1 mt-3 border-t-2 border-[--white-transparent-20] dark:border-[--black-transparent-20]">
                        <span class="mr-2 text-xs text-gray-50 dark:text-[--text-primary]">
                          Switch to {isAnnual() ? "monthly" : "annually"}
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={isAnnual()}
                          data-state={isAnnual() ? "unchecked" : "checked"}
                          value={isAnnual() ? "on" : "off"}
                          class="peer inline-flex h-4 w-8 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent dark:bg-[#3F75E0] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 bg-[--blue-400]"
                          onClick={togglePricing}
                        >
                          <span
                            data-state={isAnnual() ? "unchecked" : "checked"}
                            class={`pointer-events-none block h-4 w-4 rounded-full dark:bg-gray-500 bg-gray-50 shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 border-2 ${
                              isAnnual()
                                ? "border-blue-400 dark:border-[#3F75E0]"
                                : "border-gray-300 dark:border-[--white-transparent-20]"
                            }`}
                          />
                        </button>
                      </div>
                    </div>
                    <div class="px-6 pt-0 pb-4">
                      <button
                        onClick={openCheckoutInExternalBrowser}
                        class="flex items-center justify-center hover:opacity-90 transition-opacity duration-200 rounded-full bg-[--gray-50] dark:bg-[--gray-500] hover:bg-[--gray-200] disabled:bg-[--gray-100] font-medium text-lg px-6 h-12 w-full no-underline text-gray-500 dark:text-gray-50"
                        disabled={loading()}
                      >
                        {loading() ? "Loading..." : "Upgrade to Cap Pro"}
                      </button>
                    </div>
                    <div class="flex items-center px-6 pt-0 pb-6">
                      <div class="space-y-6">
                        <div>
                          <ul class="p-0 space-y-3 list-none">
                            {proFeatures.map((feature) => (
                              <li class="flex justify-start items-center">
                                <div class="w-6 h-6 m-0 p-0 flex items-center border-[2px] border-[--gray-50] dark:border-[--gray-500] justify-center rounded-full">
                                  <IconLucideCheck class="w-4 h-4 text-gray-50 dark:text-[--text-primary]" />
                                </div>
                                <span class="ml-2 text-[0.9rem] text-gray-50 dark:text-[--text-primary]">
                                  {feature}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
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
