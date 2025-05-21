import { Button } from "@cap/ui-solid";
import { licenseContract } from "@cap/web-api-contract";
import { useNavigate } from "@solidjs/router";
import { createMutation, useQueryClient } from "@tanstack/solid-query";
import * as tauriShell from "@tauri-apps/plugin-shell";
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
import { licenseApiClient } from "~/utils/web-api";
import { Input } from "../../editor/ui";

export default function Page() {
  const license = createLicenseQuery();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return (
    <div class="py-5 w-full max-w-[700px] mx-auto relative flex flex-col justify-start items-center h-full">
      <div class="text-center">
        <h1 class="text-4xl md:text-4xl mb-3 tracking-[-.05em] font-medium text-[--text-primary]">
          Commercial License
        </h1>
        <p class="text-base font-normal leading-6 text-gray-11 dark:text-[--black-transparent-60]">
          Permits using Cap for commercial purposes, but without paying for
          cloud features.
        </p>
      </div>
      <Button
        class="text-[--text-secondary] text-center text-base block my-4"
        variant="secondary"
        onClick={() => navigate("/upgrade")}
      >
        Looking for Cap Pro?
      </Button>
      <Switch fallback={<CommercialLicensePurchase />}>
        <Match when={license.data?.type === "pro" && license.data}>
          <div class="p-4 mt-4 space-y-4 w-full rounded-xl bg-gray-3">
            <p class="text-[--text-primary]">
              Your account is upgraded to Cap Pro and already includes a
              commercial license.
            </p>
          </div>
        </Match>
        <Match when={license.data?.type === "commercial" && license.data}>
          {(license) => (
            <div class="p-6 space-y-4 w-full rounded-xl bg-gray-3">
              <h3 class="text-2xl font-medium tracking-tight text-[--text-primary]">
                Your License
              </h3>
              <div class="flex flex-col">
                <label class="text-[--text-tertiary] text-sm">Key</label>
                <pre class="text-[--text-secondary] font-mono bg-gray-2 rounded-lg p-1 px-2">
                  {license().licenseKey}
                </pre>
              </div>
              <Show when={license().expiryDate}>
                {(expiry) => (
                  <div class="flex flex-col">
                    <label class="text-[--text-tertiary] text-sm">
                      Expires
                    </label>
                    <span class="text-[--text-secondary] mt-1 ml-0.5">
                      {new Date(expiry()).toUTCString()}
                    </span>
                  </div>
                )}
              </Show>

              {/* <p class="text-[--text-tertiary] text-sm pt-1">
                Instance ID: {license().instanceId}
              </p> */}
              <div class="flex flex-row justify-end">
                <Button variant="destructive">Deactivate License Key</Button>
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
            <div class="p-6 mt-4 space-y-2 w-full rounded-xl bg-gray-3">
              <p class="text-[--text-primary]">
                Got a license key? Enter it below
              </p>
              <Input
                placeholder="License key"
                value={licenseKey()}
                onInput={(e) => setLicenseKey(e.currentTarget.value)}
              />
              <Button
                disabled={activateLicenseKey.isPending}
                onClick={() =>
                  activateLicenseKey.mutate({ licenseKey: licenseKey() })
                }
              >
                Submit
              </Button>
              {/* <p class="text-[--text-tertiary] text-sm pt-1">
                Instance ID: {generalSettings().instanceId}
              </p> */}
            </div>
          );
        }}
      </Show>
    </Suspense>
  );
}

type CommercialLicenseType = "yearly" | "lifetime";
function CommercialLicensePurchase() {
  const openCheckoutInExternalBrowser = createMutation(() => ({
    mutationFn: async ({ type }: { type: CommercialLicenseType }) => {
      const resp = await licenseApiClient.createCommercialCheckoutUrl({
        body: { type },
      });

      if (resp.status === 200) tauriShell.open(resp.body.url);
      else throw resp.body;
    },
  }));

  const [type, setType] = createSignal<CommercialLicenseType>("yearly");

  return (
    <>
      <div class="p-3 w-full bg-blue-9 rounded-xl border shadow-sm text-card-foreground md:p-3 border-blue-500/20">
        <div class="space-y-3">
          <div class="flex flex-col space-y-1.5 pt-6 px-6">
            <h3 class="text-2xl font-medium tracking-tight text-gray-1 text-gray-12">
              Commercial License
            </h3>
            <p class="text-[0.875rem] leading-[1.25rem] text-gray-1 text-gray-12">
              For professional use without cloud features.
            </p>
            <div>
              <div class="flex items-center space-x-3">
                <h3 class="text-4xl text-gray-1 text-gray-12">
                  {type() === "yearly" ? "$29/year" : "$58"}
                </h3>
                <div>
                  {type() === "lifetime" && (
                    <p class="text-sm font-medium text-gray-1 text-gray-12">
                      billed once
                    </p>
                  )}
                  {type() === "lifetime" && (
                    <p class="text-sm text-gray-1 text-gray-12">
                      or, $29/year.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div class="px-3 md:px-8">
            <div class="flex items-center pt-4 pb-1 border-t-2 border-[--white-transparent-20] dark:border-[--black-transparent-20]">
              <span class="mr-2 text-xs text-gray-1 text-gray-12">
                Switch to {type() === "yearly" ? "lifetime" : "yearly"}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={type() === "lifetime"}
                data-state={type() === "yearly" ? "unchecked" : "checked"}
                value={type() === "lifetime" ? "on" : "off"}
                class="peer inline-flex h-4 w-8 shrink-0
                     cursor-pointer items-center rounded-full border-2 border-transparent
                     dark:bg-[#3F75E0]
                      transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
                    focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 bg-[--blue-400]"
                onClick={() =>
                  setType(type() === "yearly" ? "lifetime" : "yearly")
                }
              >
                <span
                  data-state={type() === "yearly" ? "unchecked" : "checked"}
                  class={`pointer-events-none block h-4 w-4 rounded-full dark:bg-gray-12
                         bg-gray-1 shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4
                          data-[state=unchecked]:translate-x-0 border-2 ${
                            type() === "lifetime"
                              ? "border-blue-400 dark:border-[#3F75E0]"
                              : "border-gray-300 dark:border-[--white-transparent-20]"
                          }`}
                />
              </button>
            </div>
          </div>
          <div class="px-6 pt-0 pb-4">
            <button
              onClick={() => {
                openCheckoutInExternalBrowser.mutate({ type: type() });
              }}
              disabled={openCheckoutInExternalBrowser.isPending}
              class="flex items-center justify-center hover:opacity-90 transition-opacity duration-200 rounded-full bg-[--gray-50] dark:bg-[--gray-500] hover:bg-[--gray-200] disabled:bg-[--gray-100]
                                   font-medium text-lg px-6 h-12 w-full no-underline text-gray-12 dark:text-gray-1"
            >
              Buy Commercial Licenses
            </button>
          </div>
          <div class="flex items-center px-6 pt-0 pb-6">
            <div class="space-y-6">
              <div>
                <ul class="p-0 space-y-3 list-none">
                  {[
                    "Commercial Use of Cap Recorder + Editor",
                    "Community Support",
                  ].map((feature) => (
                    <li class="flex justify-start items-center">
                      <div class="w-6 h-6 m-0 p-0 flex items-center border-[2px] border-[--gray-50] dark:border-[--gray-500] justify-center rounded-full">
                        <IconLucideCheck class="w-4 h-4 text-gray-1" />
                      </div>
                      <span class="ml-2 text-[0.9rem] text-gray-1">
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
