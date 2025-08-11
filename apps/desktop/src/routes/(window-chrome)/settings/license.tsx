import { createRive } from "@aerofoil/rive-solid-canvas";
import { Button } from "@cap/ui-solid";
import { licenseContract } from "@cap/web-api-contract";
import { createMutation, useQueryClient } from "@tanstack/solid-query";
import { ClientInferResponseBody } from "@ts-rest/core";
import {
  createResource,
  createSignal,
  Match,
  Show,
  Suspense,
  Switch,
} from "solid-js";
import { generalSettingsStore } from "~/store";
import { createLicenseQuery } from "~/utils/queries";
import { commands } from "~/utils/tauri";
import { licenseApiClient } from "~/utils/web-api";
import PricingRive from "../../../assets/rive/pricing.riv";
import { Input } from "../../editor/ui";

export default function Page() {
  const license = createLicenseQuery();
  const queryClient = useQueryClient();

  return (
    <div class="flex overflow-y-auto relative flex-col gap-3 items-center p-4 mx-auto w-full h-full custom-scroll">
      <Switch fallback={<CommercialLicensePurchase />}>
        <Match when={license.data?.type === "pro" && license.data}>
          <div class="flex justify-center items-center w-full h-screen">
            <div class="flex flex-col items-center p-6 mx-auto space-y-3 w-full max-w-md text-white rounded-3xl border bg-gray-2 border-gray-3">
              <div class="flex flex-col gap-2 items-center">
                <h3 class="text-2xl font-medium text-gray-12">
                  Cap Pro License
                </h3>
              </div>
              <p class="text-center text-gray-11">
                Your account is upgraded to{" "}
                <span class="font-semibold text-blue-500">Cap Pro</span> and
                already includes a commercial license.
              </p>
            </div>
          </div>
        </Match>
        <Match when={license.data?.type === "commercial" && license.data}>
          {(license) => (
            <div class="p-8 mx-auto mt-6 w-full max-w-[700px] text-white rounded-xl border border-gray-3 bg-gray-2">
              <div class="space-y-6">
                <div class="flex flex-col gap-2 items-center mb-4 text-center">
                  <span class="text-2xl text-green-400 fa fa-briefcase" />
                  <h3 class="text-2xl font-medium text-gray-12">
                    Commercial License
                  </h3>
                </div>
                <div>
                  <label class="block mb-2 text-sm text-gray-12">
                    License Key
                  </label>
                  <pre class="overflow-x-auto p-3 font-mono text-xs rounded-lg border border-gray-4 text-gray-9 bg-gray-3">
                    {license().licenseKey}
                  </pre>
                </div>
                <Show when={license().expiryDate}>
                  {(expiry) => (
                    <div class="space-y-1">
                      <label class="text-sm text-gray-12">Expires</label>
                      <p class="text-gray-10">
                        {new Date(expiry()).toLocaleDateString()}
                      </p>
                    </div>
                  )}
                </Show>
                <div class="my-6 h-px bg-gray-4" />
                <div class="flex flex-col items-center">
                  <Button
                    variant="destructive"
                    onClick={() => {
                      generalSettingsStore.set({
                        commercialLicense: undefined,
                      });
                      queryClient.refetchQueries({ queryKey: ["bruh"] });
                    }}
                  >
                    Deactivate License
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Match>
      </Switch>
    </div>
  );
}

function LicenseKeyActivate(props: {
  onActivated: (
    value: ClientInferResponseBody<
      (typeof licenseContract)["activateCommercialLicense"],
      200
    > & { licenseKey: string }
  ) => void;
}) {
  const [store] = createResource(() => generalSettingsStore.get());
  const queryClient = useQueryClient();

  return (
    <Suspense>
      <Show when={store()}>
        {(generalSettings) => {
          const [licenseKey, setLicenseKey] = createSignal("");

          const activateLicenseKey = createMutation(() => ({
            mutationFn: async (vars: { licenseKey: string }) => {
              const resp = await licenseApiClient.activateCommercialLicense({
                headers: {
                  licensekey: vars.licenseKey,
                  instanceid: generalSettings().instanceId!,
                },
                body: { reset: false },
              });

              if (resp.status === 200) return resp.body;
              if (
                typeof resp.body === "object" &&
                resp.body &&
                "message" in resp.body
              )
                throw resp.body.message;
              throw new Error((resp.body as any).toString());
            },
            onSuccess: (value, { licenseKey }) => {
              props.onActivated({ ...value, licenseKey });
              queryClient.refetchQueries({ queryKey: ["bruh"] });
            },
          }));

          return (
            <div class="p-6 mx-auto w-full rounded-xl border text-gray-12 bg-gray-2 border-gray-3">
              <div class="space-y-3">
                <h3 class="mb-2 text-xl text-center">Have a license key?</h3>
                <Input
                  placeholder="License key"
                  value={licenseKey()}
                  onInput={(e) => setLicenseKey(e.currentTarget.value)}
                  class="w-full bg-gray-3 border-gray-4"
                />
                <div class="flex justify-center mt-4">
                  <Button
                    variant="primary"
                    disabled={
                      activateLicenseKey.isPending || !licenseKey().trim()
                    }
                    onClick={() =>
                      activateLicenseKey.mutate({ licenseKey: licenseKey() })
                    }
                  >
                    {activateLicenseKey.isPending
                      ? "Activating..."
                      : "Activate License"}
                  </Button>
                </div>
                <Show when={activateLicenseKey.isError}>
                  <p class="mt-2 text-sm text-center text-red-500">
                    {String(activateLicenseKey.error)}
                  </p>
                </Show>
              </div>
            </div>
          );
        }}
      </Show>
    </Suspense>
  );
}

type CommercialLicenseType = "yearly" | "lifetime";
function CommercialLicensePurchase() {
  const queryClient = useQueryClient();

  const [type, setType] = createSignal<CommercialLicenseType>("yearly");

  const [isCommercialAnnual, setIsCommercialAnnual] = createSignal(true);

  const { rive: CommercialRive, RiveComponent: Commercial } = createRive(
    () => ({
      src: PricingRive,
      autoplay: true,
      artboard: "commercial",
      animations: ["card-stack"],
    })
  );

  const openCommercialCheckout = createMutation(() => ({
    mutationFn: async () => {
      const resp = await licenseApiClient.createCommercialCheckoutUrl({
        body: { type: isCommercialAnnual() ? "yearly" : "lifetime" },
      });

      if (resp.status === 200) {
        commands.openExternalLink(resp.body.url);
      }
    },
  }));

  return (
    <>
      <div class="w-full max-w-[700px] rounded-xl shadow-sm bg-gray-2">
        <div class="flex flex-col md:flex-row">
          {/* Left Column */}
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
            class="flex flex-col gap-4 items-center p-5 rounded-t-xl border md:rounded-tr-none md:rounded-tl-xl md:rounded-bl-xl border-gray-4 md:w-1/2 bg-gray-3"
          >
            <Commercial class="w-[200px]" />
            <div class="space-y-1 text-center">
              <h3 class="text-2xl font-medium tracking-tight leading-5">
                Commercial License
              </h3>
              <p class="mt-2 text-sm text-[--text-tertiary]">
                For commercial use
              </p>
            </div>
            <div class="flex flex-col justify-center items-center mt-5">
              <h3 class="text-4xl leading-6">
                {isCommercialAnnual() ? "$29" : "$58"}
                <span class="text-gray-11 text-[16px]">.00 /</span>
              </h3>
              <p class="text-[16px] font-medium text-gray-11">
                {isCommercialAnnual() ? "billed annually" : "one-time payment"}
              </p>
            </div>
            <div
              onClick={() => setIsCommercialAnnual((v) => !v)}
              class="px-3 py-2 text-center rounded-full border border-transparent transition-all duration-200 cursor-pointer w-fit bg-gray-5 hover:border-gray-400"
            >
              <p class="text-xs text-gray-12">
                Switch to {isCommercialAnnual() ? "lifetime" : "yearly"}:{" "}
                <span class="font-medium">
                  {isCommercialAnnual() ? "$58" : "$29"}
                </span>
              </p>
            </div>
            <Button
              onClick={() => openCommercialCheckout.mutate()}
              disabled={openCommercialCheckout.isPending}
              variant="lightdark"
              class="w-full !rounded-full mt-10 !h-[48px] text-lg font-medium"
              size="lg"
            >
              {openCommercialCheckout.isPending
                ? "Loading..."
                : "Purchase License"}
            </Button>
          </div>

          {/* Right Column */}
          <div class="flex flex-col gap-4 justify-center items-center p-5 rounded-t-none rounded-b-xl border border-t-0 md:border-t md:border-l-0 md:rounded-bl-none md:rounded-tr-xl md:rounded-br-xl md:w-1/2 border-gray-3">
            <ul class="flex flex-col gap-2 list-none">
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
      </div>

      <LicenseKeyActivate
        onActivated={async (value) => {
          await generalSettingsStore.set({
            commercialLicense: {
              activatedOn: Date.now(),
              expiryDate: value.expiryDate ?? null,
              refresh: value.refresh,
              licenseKey: value.licenseKey,
            },
          });
          await queryClient.refetchQueries({ queryKey: ["bruh"] });
        }}
      />
    </>
  );
}
