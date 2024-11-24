import { createSignal, onCleanup, onMount } from "solid-js";
import { getProPlanId } from "~/utils/plans";
import { commands } from "~/utils/tauri";
import { clientEnv } from "~/utils/env";
import { authStore } from "../../store";
import { Button } from "@cap/ui-solid";
import { getCurrentWindow } from "@tauri-apps/api/window";

export default function Page() {
  const proFeatures = [
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

  const getCheckoutUrl = async () => {
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

      const response = await fetch(
        `${clientEnv.VITE_SERVER_URL}/api/desktop/subscribe?origin=${window.location.origin}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth.token}`,
          },
          body: JSON.stringify({ priceId: planId }),
        }
      );

      if (response.ok) {
        const data = await response.json();
        commands.openExternalLink(data.url);
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
        upgradeComplete() ? "h-full" : ""
      }`}
    >
      {upgradeComplete() && (
        <div class="h-full flex items-center justify-center bg-gray-800 bg-opacity-75">
          <div class="bg-white p-6 rounded-lg shadow-lg text-center relative z-10">
            <h2 class="text-2xl font-bold mb-4">
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
            <div class="border text-card-foreground shadow-sm bg-blue-300 p-3 md:p-3 rounded-xl flex-grow border-blue-500/20">
              <div class="space-y-3">
                <div class="flex flex-col space-y-1.5 pt-6 px-6 pb-3">
                  <h3 class="font-medium tracking-tight text-2xl text-[--text-primary]">
                    Cap Pro — Early Adopter Pricing
                  </h3>
                  <p class="text-[0.875rem] leading-[1.25rem] text-[--text-tertiary]">
                    For professional use and teams.
                  </p>
                  <div>
                    <div class="flex items-center space-x-3">
                      <h3 class="text-4xl text-[--text-primary]">
                        {isAnnual() ? "$6/mo" : "$9/mo"}
                      </h3>
                      <div>
                        <p class="text-sm font-medium text-[--text-tertiary]">
                          {isAnnual()
                            ? "per user, billed annually."
                            : "per user, billed monthly."}
                        </p>
                        {isAnnual() && (
                          <p class="text-sm text-[--text-tertiary]">
                            or, $9/month, billed monthly.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <div class="mt-3 px-3 md:px-8">
                  <div class="flex items-center mt-3 pt-4 pb-1 border-t-2 border-gray-50/20">
                    <span class="text-xs text-[--text-tertiary] mr-2">
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
                <div class="px-6 pb-4 pt-0">
                  <button
                    onClick={getCheckoutUrl}
                    class="flex items-center justify-center rounded-full bg-[--gray-50] text-[--text-primary] hover:bg-[--gray-200] disabled:bg-[--gray-100] border border-[--gray-300] font-medium text-lg px-6 h-12 w-full no-underline"
                    disabled={loading()}
                  >
                    {loading() ? "Loading..." : "Upgrade to Cap Pro"}
                  </button>
                </div>
                <div class="flex items-center px-6 pb-6 pt-0">
                  <div class="space-y-8">
                    <div>
                      <ul class="list-none p-0 space-y-3">
                        {proFeatures.map((feature) => (
                          <li class="flex items-center justify-start">
                            <div class="w-6 h-6 m-0 p-0 flex items-center border-[2px] border-white justify-center rounded-full">
                              <IconLucideCheck class="w-5 h-5 stroke-[4px] text-[--gray-50]" />
                            </div>
                            <span class="ml-2 text-lg text-[--text-primary]">
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
