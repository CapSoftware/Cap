import { Button } from "@cap/ui-solid";
import type { licenseContract } from "@cap/web-api-contract";
import { createMutation, useQueryClient } from "@tanstack/solid-query";
import type { ClientInferResponseBody } from "@ts-rest/core";
import {
	createResource,
	createSignal,
	onMount,
	Show,
	Suspense,
} from "solid-js";
import { authStore, generalSettingsStore } from "~/store";
import { openPricingPage } from "~/utils/pricing";
import { createLicenseQuery } from "~/utils/queries";
import { commands } from "~/utils/tauri";
import { licenseApiClient } from "~/utils/web-api";
import { Input } from "../../editor/ui";
import { Section, SectionCard, SettingsPageContent } from "./Setting";
export default function Page() {
	const license = createLicenseQuery();
	const auth = authStore.createQuery();
	const queryClient = useQueryClient();
	const refreshPlan = createMutation(() => ({
		mutationFn: async () => {
			await commands.updateAuthPlan();
			await Promise.all([auth.refetch(), license.refetch()]);
		},
	}));
	onMount(() => refreshPlan.mutate());

	return (
		<div class="cap-settings-page h-full overflow-y-auto custom-scroll">
			<SettingsPageContent>
				<Section
					title="Plan & license"
					description="Your Cap plan and desktop license, in one place."
				/>
				<Show when={license.isPending}>
					<p class="text-xs text-gray-10">Loading your plan…</p>
				</Show>
				<Show when={license.isError}>
					<SectionCard padded>
						<p class="mb-3 text-xs text-gray-10">Couldn't load your plan.</p>
						<Button
							size="sm"
							variant="gray"
							onClick={() => void license.refetch()}
						>
							Try again
						</Button>
					</SectionCard>
				</Show>
				<Show when={license.data}>
					{(current) => (
						<>
							<Section title="Your plan">
								<SectionCard padded>
									<p class="text-lg font-semibold text-gray-12">
										{current().type === "pro"
											? "Cap Pro"
											: current().type === "commercial"
												? "Desktop License"
												: "Cap Free"}
									</p>
									<p class="mt-1 text-xs leading-relaxed text-gray-10">
										{current().type === "pro"
											? "Your account includes cloud sharing, Pro features and a desktop license for commercial use."
											: current().type === "commercial"
												? "Your desktop license covers commercial recording and editing. Cap Pro adds cloud sharing and collaboration features."
												: "Record and edit locally for personal use. Choose a paid plan for commercial use or more cloud features."}
									</p>
									<Show when={auth.data}>
										<Button
											class="mt-3"
											size="sm"
											variant="gray"
											disabled={refreshPlan.isPending}
											onClick={() => refreshPlan.mutate()}
										>
											{refreshPlan.isPending ? "Checking…" : "Refresh plan"}
										</Button>
										<Show when={refreshPlan.isError}>
											<p class="mt-2 text-xs text-gray-10">
												Couldn't refresh your plan. Please try again.
											</p>
										</Show>
									</Show>
									<Show when={!auth.data}>
										<p class="mt-3 text-xs leading-relaxed text-gray-10">
											Already have Cap Pro? Sign in with your account from the
											sidebar.
										</p>
									</Show>
								</SectionCard>
							</Section>
							<Section
								title="Explore plans"
								description="Compare current pricing and everything included on our website."
							>
								<SectionCard padded>
									<div class="space-y-3 text-xs leading-relaxed text-gray-10">
										<p>
											<span class="font-medium text-gray-12">
												Desktop License
											</span>{" "}
											· Commercial use of the desktop recorder and editor.
										</p>
										<p>
											<span class="font-medium text-gray-12">Cap Pro</span> · A
											desktop license, plus cloud sharing, AI features and
											collaboration.
										</p>
										<Button
											size="sm"
											variant="dark"
											onClick={() => void openPricingPage()}
										>
											View plans & pricing ↗
										</Button>
										<p>Opens cap.so/pricing in your browser.</p>
									</div>
								</SectionCard>
							</Section>
							<Show when={current().type !== "pro"}>
								<Show
									when={license.data?.type === "commercial" && license.data}
									fallback={
										<LicenseKeyActivate
											onActivated={(value) => {
												generalSettingsStore
													.set({
														commercialLicense: {
															licenseKey: value.licenseKey,
															expiryDate: value.expiryDate ?? null,
															activatedOn: Date.now(),
															refresh: value.refresh,
														},
													})
													.then(() =>
														queryClient.refetchQueries({
															queryKey: ["licenseQuery"],
														}),
													);
											}}
										/>
									}
								>
									{(commercial) => (
										<Section title="Desktop license">
											<SectionCard padded>
												<p class="mb-2 text-xs text-gray-10">License key</p>
												<pre class="overflow-x-auto p-3 text-xs rounded-lg bg-gray-3 text-gray-11">
													{commercial().licenseKey}
												</pre>
												<Show when={commercial().expiryDate}>
													{(expiry) => (
														<p class="mt-3 text-xs text-gray-10">
															Expires {new Date(expiry()).toLocaleDateString()}
														</p>
													)}
												</Show>
												<Button
													class="mt-4"
													size="sm"
													variant="destructive"
													onClick={async () => {
														await generalSettingsStore.set({
															commercialLicense: undefined,
														});
														await queryClient.refetchQueries({
															queryKey: ["licenseQuery"],
														});
													}}
												>
													Deactivate license
												</Button>
											</SectionCard>
										</Section>
									)}
								</Show>
							</Show>
						</>
					)}
				</Show>
			</SettingsPageContent>
		</div>
	);
}

function LicenseKeyActivate(props: {
	onActivated: (
		value: ClientInferResponseBody<
			(typeof licenseContract)["activateCommercialLicense"],
			200
		> & { licenseKey: string },
	) => void;
}) {
	const [store] = createResource(() => generalSettingsStore.get());
	const queryClient = useQueryClient();

	return (
		<Suspense>
			<Show when={store()}>
				{(generalSettings) => {
					const [licenseKey, setLicenseKey] = createSignal("");
					const instanceId = generalSettings().instanceId;
					if (!instanceId) throw new Error("No instance ID found");

					const activateLicenseKey = createMutation(() => ({
						mutationFn: async (vars: { licenseKey: string }) => {
							const resp = await licenseApiClient.activateCommercialLicense({
								headers: {
									licensekey: vars.licenseKey,
									instanceid: instanceId,
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
							throw new Error(String(resp.body));
						},
						onSuccess: (value, { licenseKey }) => {
							props.onActivated({ ...value, licenseKey });
							queryClient.refetchQueries({ queryKey: ["licenseQuery"] });
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
