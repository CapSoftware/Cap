import { createSignal, onCleanup, onMount } from "solid-js";
import { Button } from "@cap/ui-solid";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { authStore } from "../../store";
import { getProPlanId } from "~/utils/plans";
import { commands } from "~/utils/tauri";
import { apiClient, protectedHeaders } from "~/utils/web-api";

export default function Page() {
  const proFeatures = [
    "Remove watermark from recordings",
    "Unlimited cloud storage & Shareable links",
    "Connect custom S3 storage bucket",
    "Advanced teams features",
    "Unlimited views",
    "Password protected videos",
    "Advanced analytics",
    "Priority support",
  ];

  const [isAnnual, setIsAnnual] = createSignal(true);
  const [upgradeComplete, setUpgradeComplete] = createSignal(false);
  const [loading, setLoading] = createSignal(false);

  const togglePricing = () => {
    setIsAnnual(!isAnnual());
  };

  const openCheckoutInExternalBrowser = async () => {
    setLoading(true);
    const planId = getProPlanId(isAnnual() ? "yearly" : "monthly");

    try {
      const auth = await authStore.get();

      if (!auth) {
        console.error("User not authenticated");
        const window = getCurrentWindow();
        window.close();
        return;
      }

      const response = await apiClient.desktop.getProSubscribeURL({
        body: { priceId: planId },
        headers: await protectedHeaders(),
      });

      if (response.status === 200) {
        commands.openExternalLink(response.body.url);
      } else {
        console.error("Failed to get checkout URL");
      }
    } catch (error) {
      console.error("Error getting checkout URL:", error);
    } finally {
      setLoading(false);
    }
  };

  const checkUpgradeStatus = async () => {
    const result = await commands.checkUpgradedAndUpdate();
    if (result) {
      setUpgradeComplete(true);
    }
  };

  onMount(() => {
    const interval = setInterval(checkUpgradeStatus, 5000);
    onCleanup(() => clearInterval(interval));
  });
  return (
    <div
      class={`py-5 max-w-[700px] mx-auto relative ${
        upgradeComplete() ? "h-full" : ""}`}
    >
      {upgradeComplete() && (
        <div class="flex justify-center items-center h-full bg-gray-800 bg-opacity-75">
          <div class="relative z-10 p-6 text-center bg-white rounded-lg shadow-lg">
            <h2 class="mb-4 text-2xl font-bold">
              Upgrade complete - Welcome to Cap Pro!
            </h2>
            <Button
              onClick={() => {
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
          <div class="text-center">
            <h1 class="text-4xl md:text-4xl mb-3 tracking-[-.05em] font-medium text-[--text-primary]">
              Upgrade to Cap Pro
            </h1>
            <p class="text-base font-normal leading-6 text-gray-400">
              Cap is currently in public beta, and we're offering special early
              adopter pricing to our first users.{" "}
              <span class="text-gray-500">
                This pricing will be locked in for the lifetime of your
                subscription.
              </span>
            </p>
          </div>
          <div class="flex flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400] flex-1 bg-gray-100">
            <div class="flex-grow p-3 bg-blue-300 rounded-xl border shadow-sm text-card-foreground md:p-3 border-blue-500/20">
              <div class="space-y-3">
                <div class="flex flex-col space-y-1.5 pt-6 px-6 pb-3">
                  <h3 class="text-2xl font-medium tracking-tight text-gray-50 dark:text-[--text-primary]">
                    Cap Pro — Early Adopter Pricing
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
                  <div class="flex items-center pt-4 pb-1 mt-3 border-t-2 border-[--gray-400]">
                    <span class="mr-2 text-xs text-gray-50 dark:text-[--text-primary]">
                      Switch to {isAnnual() ? "monthly" : "annually"}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isAnnual()}
                      data-state={isAnnual() ? "unchecked" : "checked"}
                      value={isAnnual() ? "on" : "off"}
                      class="peer inline-flex h-4 w-8 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 bg-[--blue-400]"
                      onClick={togglePricing}
                    >
                      <span
                        data-state={isAnnual() ? "unchecked" : "checked"}
                        class="pointer-events-none block h-4 w-4 rounded-full bg-[--gray-50] shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"
                      />
                    </button>
                  </div>
                </div>
                <div class="px-6 pt-0 pb-4">
                  <button
                    onClick={openCheckoutInExternalBrowser}
                    class="flex items-center justify-center rounded-full bg-[--gray-50] hover:bg-[--gray-200] disabled:bg-[--gray-100] border
                     border-[--gray-300] font-medium text-lg px-6 h-12 w-full no-underline dark:text-[--text-primary]"
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
                            <div class="w-6 h-6 m-0 p-0 flex items-center border-[2px] border-[--gray-400] justify-center rounded-full">
                              <IconLucideCheck class="w-4 h-4 text-[--gray-50] dark:text-[--text-primary]" />
                            </div>
                            <span class="ml-2 text-[0.9rem] dark:text-[--text-primary]">
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
    </div>
  );
}
