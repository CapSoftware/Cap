import { Button } from "@cap/ui-solid";
import { createMutation, useQueryClient } from "@tanstack/solid-query";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { type Accessor, createSignal, Show } from "solid-js";
import { generalSettingsStore } from "~/store";
import { getProPlanId } from "~/utils/plans";
import { createLicenseQuery } from "~/utils/queries";
import { createRive } from "~/utils/rive";
import { commands } from "~/utils/tauri";
import { apiClient, licenseApiClient, protectedHeaders } from "~/utils/web-api";
import PricingRive from "../../assets/rive/pricing.riv";
import { authStore } from "../../store";

import { Dialog, DialogContent, Input } from "../editor/ui";

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
import { createSignInMutation } from "~/utils/auth";

RuntimeLoader.setWasmUrl(riveWASMResource);

export default function Page() {
	const [isProAnnual, setIsProAnnual] = createSignal(true);
	const [isCommercialAnnual, setIsCommercialAnnual] = createSignal(true);
	const [upgradeComplete, _setUpgradeComplete] = createSignal(false);
	const [loading, setLoading] = createSignal(false);
	const signIn = createSignInMutation();
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

			console.log({ auth });
			if (!auth) {
				console.log("No auth found, starting sign in flow");
				await signIn.mutateAsync(new AbortController());
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
				if (window) await window.minimize();
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

	// onMount(async () => {
	//   console.log("Component mounted");
	//   const unsubscribeDeepLink = await onOpenUrl(async (urls) => {
	//     console.log("Deep link received:", urls);
	//     const isDevMode = import.meta.env.VITE_ENVIRONMENT === "development";
	//     if (isDevMode) {
	//       console.log("In dev mode, ignoring deep link");
	//       return;
	//     }

	//     for (const url of urls) {
	//       if (!url.includes("token=")) {
	//         console.log("URL does not contain token, skipping");
	//         return;
	//       }

	//       console.log("Processing auth URL");
	//       const urlObject = new URL(url);
	//       const token = urlObject.searchParams.get("token");
	//       const user_id = urlObject.searchParams.get("user_id");
	//       const expires = Number(urlObject.searchParams.get("expires"));

	//       if (!token || !expires || !user_id) {
	//         console.error("Invalid signin params");
	//         throw new Error("Invalid signin params");
	//       }

	//       console.log("Setting auth store with new credentials");
	//       const existingAuth = await authStore.get();
	//       await authStore.set({
	//         token,
	//         user_id,
	//         expires,
	//         plan: {
	//           upgraded: false,
	//           last_checked: 0,
	//           manual: existingAuth?.plan?.manual ?? false,
	//         },
	//       });

	//       console.log("Identifying user in analytics");
	//       identifyUser(user_id);
	//       console.log("Tracking sign in event");
	//       trackEvent("user_signed_in", { platform: "desktop" });

	//       console.log("Reopening upgrade window");
	//       await commands.showWindow("Upgrade");

	//       console.log("Waiting for window to be ready");
	//       await new Promise((resolve) => setTimeout(resolve, 500));

	//       console.log("Getting upgrade window reference");
	//       const upgradeWindow = await Window.getByLabel("upgrade");
	//       if (upgradeWindow) {
	//         try {
	//           console.log("Setting focus on upgrade window");
	//           await upgradeWindow.show();
	//           await upgradeWindow.setFocus();
	//         } catch (e) {
	//           console.error("Failed to focus upgrade window:", e);
	//         }
	//       }

	//       console.log("Getting checkout URL");
	//       const planId = getProPlanId(isProAnnual() ? "yearly" : "monthly");
	//       const response = await apiClient.desktop.getProSubscribeURL({
	//         body: { priceId: planId },
	//         headers: await protectedHeaders(),
	//       });

	//       if (response.status === 200) {
	//         console.log("Opening checkout URL in external browser");
	//         commands.openExternalLink(response.body.url);
	//         console.log("Minimizing upgrade window");
	//         if (upgradeWindow) {
	//           await upgradeWindow.minimize();
	//         }
	//       }
	//     }
	//   });

	//   onCleanup(() => {
	//     console.log("Cleaning up deep link listener");
	//     unsubscribeDeepLink();
	//   });

	//   console.log("Setting up upgrade status check interval");
	//   const interval = setInterval(async () => {
	//     console.log("Checking upgrade status");
	//     const result = await commands.checkUpgradedAndUpdate();
	//     if (result) {
	//       console.log("Upgrade complete");
	//       setUpgradeComplete(true);
	//     }
	//   }, 5000);
	//   onCleanup(() => {
	//     console.log("Cleaning up upgrade status check interval");
	//     clearInterval(interval);
	//   });
	// });

	const { rive: CommercialRive, RiveComponent: Commercial } = createRive(
		() => ({
			src: PricingRive,
			autoplay: true,
			artboard: "commercial",
			animations: ["card-stack"],
		}),
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
				<div class="flex justify-center items-center h-full bg-opacity-75">
					<div class="relative z-10 p-6 text-center bg-white rounded-lg shadow-lg">
						<h2 class="mb-4 text-2xl font-bold">Upgrade complete</h2>
						<p class="mb-4 text-sm text-gray-10">
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
			{!upgradeComplete() &&
				(license.data?.type === "commercial" ? (
					<div class="p-8 mx-auto w-full max-w-[700px] rounded-xl border shadow-sm bg-gray-2 border-gray-3">
						<div class="space-y-6">
							<div class="flex flex-col items-center mb-6 text-center">
								<h3 class="text-2xl font-medium">Commercial License</h3>
								<p class="text-sm text-gray-11">
									Your license details for Cap commercial use
								</p>
							</div>

							<div class="space-y-6">
								<div>
									<label class="block mb-2 text-sm text-gray-12">
										License Key
									</label>
									<p class="overflow-x-auto p-3 font-mono text-xs whitespace-pre-wrap break-all rounded-lg border border-gray-4 text-gray-9 bg-gray-3">
										{license.data.licenseKey}
									</p>
								</div>

								<Show when={license.data.expiryDate}>
									{(expiryDate) => (
										<div class="space-y-1">
											<label class="text-sm text-gray-12">Expires</label>
											<p class="text-gray-10">
												{new Date(expiryDate()).toLocaleDateString(undefined, {
													year: "numeric",
													month: "long",
													day: "numeric",
												})}
											</p>
										</div>
									)}
								</Show>

								<div class="flex flex-col items-center pt-6 border-t border-gray-3">
									<Button
										variant="destructive"
										disabled={resetLicense.isPending}
										onClick={() => {
											resetLicense.mutate();
										}}
									>
										{resetLicense.isPending
											? "Deactivating..."
											: "Deactivate License"}
									</Button>
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
								class="flex flex-col flex-1 justify-between p-3 h-[700px ] bg-gray-3 rounded-2xl border border-gray-3 shadow-sm text-card-foreground md:p-3"
							>
								<div class="space-y-5">
									<div class="flex flex-col gap-6 items-center">
										<Commercial class="w-[250px]" />
										<div class="space-y-1 text-center">
											<h3 class="text-2xl font-medium tracking-tight leading-5">
												Commercial License
											</h3>
											<p class="mt-2 text-sm text-[--text-tertiary]">
												For commercial use
											</p>
										</div>
										<div class="flex flex-col justify-center items-center">
											<h3 class="text-4xl leading-6">
												{isCommercialAnnual() ? "$29" : "$58"}
												<span class="text-gray-11 text-[16px]">.00 /</span>
											</h3>
											{isCommercialAnnual() && (
												<p class="text-[16px] font-medium text-gray-11">
													billed annually
												</p>
											)}
											{!isCommercialAnnual() && (
												<p class="text-[16px] font-medium text-gray-11">
													one-time payment
												</p>
											)}
										</div>
										<div
											onClick={() => setIsCommercialAnnual((v) => !v)}
											class="px-3 py-2 text-center rounded-full border border-transparent transition-all duration-200 cursor-pointer bg-gray-5 hover:border-gray-400"
										>
											<p class="text-xs text-gray-12">
												Switch to {isCommercialAnnual() ? "lifetime" : "yearly"}
												:{" "}
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
									<Button
										onClick={() => openCommercialCheckout.mutate()}
										disabled={openCommercialCheckout.isPending}
										variant="dark"
										class="w-full !rounded-full !h-[48px] text-lg font-medium"
										size="lg"
									>
										{openCommercialCheckout.isPending
											? "Loading..."
											: "Purchase License"}
									</Button>
									<p
										onClick={() => setOpenLicenseDialog(true)}
										class="mb-2 text-sm transition-colors cursor-pointer text-gray-11 hover:text-gray-12"
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
								class="flex-grow p-3 h-[700px] flex-1 bg-gray-12 rounded-2xl border shadow-sm text-card-foreground md:p-3"
							>
								<div class="flex flex-col justify-between space-y-5 h-full">
									<div class="flex flex-col gap-6 items-center px-6">
										<Pro class="w-[250px]" />
										<div class="space-y-1 text-center">
											<h3 class="text-2xl font-medium tracking-tight leading-5 text-gray-1">
												Cap Pro
											</h3>
											<p class="text-[0.875rem] text-gray-9">
												For professional use and teams.
											</p>
										</div>
										<div class="flex flex-col justify-center items-center">
											<h3 class="text-4xl leading-6 text-gray-1">
												{isProAnnual() ? "$8.16" : "$12"}
												<span class="text-gray-10 text-[16px]">.00 /</span>
											</h3>
											{isProAnnual() && (
												<p class="text-[16px] font-medium text-gray-9">
													per user, billed annually
												</p>
											)}
											{!isProAnnual() && (
												<p class="text-[16px] font-medium text-gray-9">
													per user, billed monthly
												</p>
											)}
										</div>
										<div
											onClick={() => setIsProAnnual((v) => !v)}
											class="px-3 py-2 text-center bg-blue-500 rounded-full border border-transparent transition-all duration-200 cursor-pointer hover:border-blue-400"
										>
											<p class="text-xs text-solid-white">
												Switch to {isProAnnual() ? "monthly" : "yearly"}:{" "}
												<span class="font-medium">
													{isProAnnual()
														? "$12 per user, billed monthly"
														: "$8.16 per user, billed annually"}
												</span>
											</p>
										</div>
										<ul class="flex flex-col gap-2 justify-center list-none">
											{proFeatures.map((feature) => (
												<li class="flex justify-start items-center text-gray-1">
													<div class="flex justify-center items-center p-0 m-0 size-4">
														<IconLucideCheck class="size-4" />
													</div>
													<span class="ml-2 text-[0.9rem]">{feature}</span>
												</li>
											))}
										</ul>
									</div>
									<Button
										variant="blue"
										class="!rounded-full !text-lg w-full mx-auto"
										onClick={openCheckoutInExternalBrowser}
									>
										{loading() ? "Loading..." : "Upgrade to Cap Pro"}
									</Button>
								</div>
							</div>
						</div>
					</>
				))}
		</div>
	);
}

interface Props {
	open: Accessor<boolean>;
	onOpenChange: (open: boolean) => void;
}

const ActivateLicenseDialog = ({ open, onOpenChange }: Props) => {
	const [licenseKey, setLicenseKey] = createSignal("");
	const queryClient = useQueryClient();

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
			await queryClient.refetchQueries({ queryKey: ["bruh"] });
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
