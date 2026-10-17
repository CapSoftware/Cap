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
					title="版本与许可证"
					description="你的 Cap 版本与桌面版许可证，尽在一处。"
				/>
				<Show when={license.isPending}>
					<p class="text-xs text-gray-10">正在加载你的版本信息…</p>
				</Show>
				<Show when={license.isError}>
					<SectionCard padded>
						<p class="mb-3 text-xs text-gray-10">无法加载你的版本信息。</p>
						<Button
							size="sm"
							variant="gray"
							onClick={() => void license.refetch()}
						>
							重试
						</Button>
					</SectionCard>
				</Show>
				<Show when={license.data}>
					{(current) => (
						<>
							<Section title="你的版本">
								<SectionCard padded>
									<p class="text-lg font-semibold text-gray-12">
										{current().type === "pro"
											? "Cap 专业版"
											: current().type === "commercial"
												? "桌面版许可证"
												: "Cap 免费版"}
									</p>
									<p class="mt-1 text-xs leading-relaxed text-gray-10">
										{current().type === "pro"
											? "你的账户包含云分享、专业版功能，以及可用于商业用途的桌面版许可证。"
											: current().type === "commercial"
												? "桌面版许可证涵盖商业录制与剪辑。Cap 专业版额外提供云分享与协作功能。"
												: "本地录制与剪辑，供个人使用。商业用途或需要更多云端功能请选择付费版本。"}
									</p>
									<Show when={auth.data}>
										<Button
											class="mt-3"
											size="sm"
											variant="gray"
											disabled={refreshPlan.isPending}
											onClick={() => refreshPlan.mutate()}
										>
											{refreshPlan.isPending ? "检查中…" : "刷新版本信息"}
										</Button>
										<Show when={refreshPlan.isError}>
											<p class="mt-2 text-xs text-gray-10">
												无法刷新你的版本信息，请重试。
											</p>
										</Show>
									</Show>
									<Show when={!auth.data}>
										<p class="mt-3 text-xs leading-relaxed text-gray-10">
											已经有 Cap 专业版？从侧边栏用你的账户登录。
										</p>
									</Show>
								</SectionCard>
							</Section>
							<Section
								title="查看各版本"
								description="在我们网站上查看最新价格与各版本包含的功能。"
							>
								<SectionCard padded>
									<div class="space-y-3 text-xs leading-relaxed text-gray-10">
										<p>
											<span class="font-medium text-gray-12">
												桌面版许可证
											</span>{" "}
											· 桌面录制与编辑器的商业使用授权。
										</p>
										<p>
											<span class="font-medium text-gray-12">Cap 专业版</span> · 桌面版许可证，外加云分享、AI 功能和协作。
										</p>
										<Button
											size="sm"
											variant="dark"
											onClick={() => void openPricingPage()}
										>
											View plans & pricing ↗
										</Button>
										<p>在你的浏览器中打开 cap.so/pricing。</p>
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
										<Section title="桌面版许可证">
											<SectionCard padded>
												<p class="mb-2 text-xs text-gray-10">许可证密钥</p>
												<pre class="overflow-x-auto p-3 text-xs rounded-lg bg-gray-3 text-gray-11">
													{commercial().licenseKey}
												</pre>
												<Show when={commercial().expiryDate}>
													{(expiry) => (
														<p class="mt-3 text-xs text-gray-10">
															过期时间 {new Date(expiry()).toLocaleDateString()}
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
													停用许可证
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
								<h3 class="mb-2 text-xl text-center">有许可证密钥？</h3>
								<Input
									placeholder="许可证密钥"
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
											: "激活许可证"}
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
