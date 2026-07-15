import { Button } from "@cap/ui-solid";
import { A, type RouteSectionProps, useNavigate } from "@solidjs/router";
import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { getVersion } from "@tauri-apps/api/app";
import * as dialog from "@tauri-apps/plugin-dialog";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import * as shell from "@tauri-apps/plugin-shell";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
	Suspense,
} from "solid-js";
import { CapErrorBoundary } from "~/components/CapErrorBoundary";
import { SignInButton } from "~/components/SignInButton";

import { authStore, userProfileStore } from "~/store";
import { trackEvent } from "~/utils/analytics";
import { createSignInMutation } from "~/utils/auth";
import { commands } from "~/utils/tauri";
import {
	apiClient,
	getConfiguredServerUrl,
	protectedHeaders,
} from "~/utils/web-api";
import IconLucideTerminal from "~icons/lucide/terminal";
import IconLucideUserRound from "~icons/lucide/user-round";
import IconLucideZap from "~icons/lucide/zap";

const USER_PROFILE_CACHE_GC_MS = 2 * 60 * 60 * 1000;
const USER_PROFILE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;

type AuthState = Awaited<ReturnType<typeof authStore.get>>;
type CachedUserProfile = Awaited<ReturnType<typeof userProfileStore.get>>;

function profileQueryKey(userId: string | null | undefined) {
	return ["settings-user-profile", userId ?? null] as const;
}

function isAuthExpired(auth: AuthState) {
	const secret = auth?.secret;
	return !!secret && "expires" in secret && secret.expires * 1000 <= Date.now();
}

function isCachedProfileForUser(
	cachedProfile: CachedUserProfile,
	userId: string | null | undefined,
) {
	return cachedProfile?.userId === (userId ?? null);
}

async function loadProfileImageObjectUrl(signal: AbortSignal) {
	const imageUrl = new URL(
		"/api/desktop/user/profile/image",
		await getConfiguredServerUrl(),
	).toString();

	const response = await tauriFetch(imageUrl, {
		headers: await protectedHeaders(),
		signal,
	});
	if (!response.ok) throw new Error("加载头像失败");

	const contentType = response.headers.get("content-type");
	if (contentType && !contentType.toLowerCase().startsWith("image/")) {
		throw new Error("头像响应格式无效");
	}

	const contentLength = Number(response.headers.get("content-length"));
	if (contentLength > MAX_PROFILE_IMAGE_BYTES) {
		throw new Error("头像文件过大");
	}

	const blob = await response.blob();
	if (blob.size > MAX_PROFILE_IMAGE_BYTES) {
		throw new Error("头像文件过大");
	}

	return URL.createObjectURL(blob);
}

function SettingsContentSkeleton() {
	return (
		<div class="cap-settings-page flex flex-col h-full custom-scroll">
			<div class="px-6 py-6 space-y-7 max-w-[42rem]" aria-hidden="true">
				<div class="space-y-2.5">
					<div class="px-1 space-y-1.5">
						<div class="h-4 w-28 rounded-full bg-gray-4 animate-pulse" />
						<div class="h-3 w-72 max-w-full rounded-full bg-gray-4 animate-pulse" />
					</div>
					<div class="cap-settings-card overflow-hidden rounded-xl border border-gray-3 bg-gray-2 divide-y divide-gray-3">
						<div class="px-4 py-3.5 space-y-2">
							<div class="h-[15px] w-40 rounded-full bg-gray-4 animate-pulse" />
							<div class="h-3 w-64 max-w-full rounded-full bg-gray-4 animate-pulse" />
						</div>
						<div class="px-4 py-3.5 space-y-2">
							<div class="h-[15px] w-36 rounded-full bg-gray-4 animate-pulse" />
							<div class="h-3 w-56 max-w-full rounded-full bg-gray-4 animate-pulse" />
						</div>
						<div class="px-4 py-3.5 space-y-2">
							<div class="h-[15px] w-44 rounded-full bg-gray-4 animate-pulse" />
							<div class="h-3 w-60 max-w-full rounded-full bg-gray-4 animate-pulse" />
						</div>
					</div>
				</div>
				<div class="space-y-2.5">
					<div class="px-1 space-y-1.5">
						<div class="h-4 w-36 rounded-full bg-gray-4 animate-pulse" />
						<div class="h-3 w-64 max-w-full rounded-full bg-gray-4 animate-pulse" />
					</div>
					<div class="cap-settings-card overflow-hidden rounded-xl border border-gray-3 bg-gray-2 divide-y divide-gray-3">
						<div class="px-4 py-3.5 space-y-2">
							<div class="h-[15px] w-48 rounded-full bg-gray-4 animate-pulse" />
							<div class="h-3 w-52 max-w-full rounded-full bg-gray-4 animate-pulse" />
						</div>
						<div class="px-4 py-3.5 space-y-2">
							<div class="h-[15px] w-32 rounded-full bg-gray-4 animate-pulse" />
							<div class="h-3 w-72 max-w-full rounded-full bg-gray-4 animate-pulse" />
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

export default function Settings(props: RouteSectionProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const signIn = createSignInMutation();
	const [auth, setAuth] =
		createSignal<Awaited<ReturnType<typeof authStore.get>>>();
	const [authLoaded, setAuthLoaded] = createSignal(false);
	const [version, setVersion] = createSignal<string | null>(null);
	const [isCheckingForUpdates, setIsCheckingForUpdates] = createSignal(false);
	const [failedProfileImageUrl, setFailedProfileImageUrl] = createSignal<
		string | null
	>(null);
	const [profileImageObjectUrl, setProfileImageObjectUrl] = createSignal<
		string | null
	>(null);
	const clearLocalAuth = async () => {
		setAuth(undefined);
		queryClient.removeQueries({ queryKey: ["settings-user-profile"] });
		await Promise.all([
			authStore.set(undefined),
			userProfileStore.set(undefined),
		]);
	};
	const userProfile = createQuery(() => ({
		queryKey: profileQueryKey(auth()?.user_id),
		enabled: !!auth(),
		staleTime: USER_PROFILE_REFRESH_INTERVAL_MS,
		gcTime: USER_PROFILE_CACHE_GC_MS,
		refetchOnMount: true,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		queryFn: async () => {
			const currentAuth = auth();
			if (!currentAuth) return null;

			if (isAuthExpired(currentAuth)) {
				await clearLocalAuth();
				return null;
			}

			const response = await apiClient.desktop.getUserProfile({
				headers: await protectedHeaders(),
			});

			if (response.status === 401) {
				await clearLocalAuth();
				return null;
			}

			if (response.status !== 200) throw new Error("加载账户资料失败");

			await userProfileStore.set({
				userId: currentAuth.user_id,
				profile: response.body,
				updatedAt: Date.now(),
			});

			return response.body;
		},
	}));
	const settingsItems = [
		{
			href: "general",
			name: "通用",
			icon: IconCapSettings,
		},
		{
			href: "hotkeys",
			name: "快捷键",
			icon: IconCapHotkeys,
		},
		{
			href: "cli",
			name: "CLI",
			icon: IconLucideTerminal,
		},
		{
			href: "recordings",
			name: "录制",
			icon: IconLucideSquarePlay,
		},
		{
			href: "screenshots",
			name: "截图",
			icon: IconLucideImage,
		},
		{
			href: "automations",
			name: "自动化",
			icon: IconLucideZap,
		},
		{
			href: "transcription",
			name: "转录",
			icon: IconCapCaptions,
		},
		{
			href: "integrations",
			name: "集成",
			icon: IconLucideUnplug,
		},
		{
			href: "license",
			name: "许可证",
			icon: IconLucideGift,
		},
		{
			href: "experimental",
			name: "实验性功能",
			icon: IconCapSettings,
		},
		{
			href: "feedback",
			name: "反馈",
			icon: IconLucideMessageSquarePlus,
		},
		{
			href: "changelog",
			name: "更新日志",
			icon: IconLucideBell,
		},
	];
	const accountName = createMemo(() => {
		if (!auth()) return "点击登录";
		if (!userProfile.isSuccess) return "已登录";

		const name = userProfile.data?.name?.trim();
		if (name) return name;

		const email = userProfile.data?.email?.trim();
		if (email) return email;

		return "已登录";
	});
	const accountRemoteImageUrl = createMemo(() => {
		if (!userProfile.isSuccess) return null;

		const imageUrl = userProfile.data?.imageUrl?.trim();
		if (imageUrl && imageUrl === failedProfileImageUrl()) return null;

		return imageUrl || null;
	});
	const accountImageUrl = createMemo(() => profileImageObjectUrl());
	const openDashboard = () => {
		void getConfiguredServerUrl().then((serverUrl) =>
			shell.open(new URL("/dashboard", serverUrl).toString()),
		);
	};
	const handleProfileClick = () => {
		if (auth()) {
			openDashboard();
			return;
		}

		if (signIn.isPending) {
			signIn.variables.abort();
			signIn.reset();
			return;
		}

		signIn.mutate(new AbortController());
	};
	const handleProfileImageError = (imageUrl: string) => {
		setFailedProfileImageUrl(imageUrl);
		void userProfile.refetch();
	};

	createEffect(
		on(accountRemoteImageUrl, (imageUrl) => {
			setProfileImageObjectUrl(null);

			if (!imageUrl) return;

			const abort = new AbortController();
			let disposed = false;
			let objectUrl: string | null = null;

			void loadProfileImageObjectUrl(abort.signal)
				.then((url) => {
					if (disposed) {
						URL.revokeObjectURL(url);
						return;
					}

					objectUrl = url;
					setProfileImageObjectUrl(url);
				})
				.catch(() => {
					if (!disposed && !abort.signal.aborted) {
						handleProfileImageError(imageUrl);
					}
				});

			onCleanup(() => {
				disposed = true;
				abort.abort();
				if (objectUrl) URL.revokeObjectURL(objectUrl);
			});
		}),
	);

	onMount(() => {
		void getVersion()
			.then(setVersion)
			.catch((error) => console.error("Failed to load app version:", error));
	});

	let disposed = false;
	let stopAuthListening: (() => void) | undefined;
	const applyAuth = (value: AuthState) => {
		if (isAuthExpired(value)) {
			void clearLocalAuth();
			setAuthLoaded(true);
			return;
		}

		setAuth(() => value);
		setAuthLoaded(true);
	};

	onMount(() => {
		void Promise.all([authStore.get(), userProfileStore.get()])
			.then(([value, cachedProfile]) => {
				if (disposed) return;

				if (
					value &&
					cachedProfile &&
					isCachedProfileForUser(cachedProfile, value.user_id)
				) {
					queryClient.setQueryData(
						profileQueryKey(value.user_id),
						cachedProfile.profile,
						{ updatedAt: cachedProfile.updatedAt },
					);
				}

				if (isAuthExpired(value)) {
					void clearLocalAuth();
					return;
				}

				setAuth(() => value);
			})
			.catch((error) => console.error("Failed to load auth store:", error))
			.finally(() => {
				if (!disposed) setAuthLoaded(true);
			});

		void authStore
			.listen(applyAuth)
			.then((unlisten) => {
				if (disposed) {
					unlisten();
					return;
				}
				stopAuthListening = unlisten;
			})
			.catch((error) =>
				console.error("Failed to listen to auth store:", error),
			);
	});

	onCleanup(() => {
		disposed = true;
		stopAuthListening?.();
	});

	const handleAuth = async () => {
		if (auth()) {
			trackEvent("user_signed_out", { platform: "desktop" });
			await clearLocalAuth();
		}
	};

	const checkForUpdates = async () => {
		setIsCheckingForUpdates(true);

		try {
			const update = await commands.updatesCheck();

			if (!update) {
				await dialog.message("你已经在使用最新版 Cap。", {
					title: "暂无可用更新",
					kind: "info",
				});
				return;
			}

			const shouldUpdate = await dialog.confirm(
				`Cap ${update.version} 版本现已可用，是否安装？`,
				{ title: "更新 Cap", okLabel: "更新", cancelLabel: "忽略" },
			);

			if (shouldUpdate) navigate("/update");
		} catch (e) {
			console.error("Failed to check for updates:", e);
			const openDownload = await dialog
				.confirm(
					"无法自动检查更新。你可以前往 cap.so/download 下载最新版 Cap，你的数据不会丢失。",
					{ title: "更新 Cap", okLabel: "下载", cancelLabel: "稍后" },
				)
				.catch(() => false);
			if (openDownload) await shell.open("https://cap.so/download");
		} finally {
			setIsCheckingForUpdates(false);
		}
	};

	return (
		<div class="cap-settings-shell flex-1 flex flex-row divide-x divide-gray-3 text-[0.875rem] leading-5 overflow-y-hidden">
			<div
				class="cap-settings-sidebar flex flex-col h-full bg-gray-2"
				data-tauri-drag-region
			>
				<div class="cap-settings-window-spacer" data-tauri-drag-region />
				<button
					type="button"
					class="cap-settings-profile flex h-11 gap-2 items-center mx-2 mt-2 mb-3 px-2 py-1.5 rounded-lg text-left transition-colors hover:bg-gray-3"
					data-tauri-drag-region="false"
					onClick={handleProfileClick}
				>
					<Show
						when={accountImageUrl()}
						fallback={
							<div class="cap-settings-profile-icon flex justify-center items-center size-8 shrink-0 rounded-full bg-gray-3 text-gray-11">
								<IconLucideUserRound class="size-4" aria-hidden="true" />
							</div>
						}
					>
						{(imageUrl) => (
							<img
								class="cap-settings-profile-image size-8 shrink-0 rounded-full object-cover bg-gray-3"
								src={imageUrl()}
								alt=""
								draggable={false}
								onError={() => {
									const remoteUrl = accountRemoteImageUrl();
									if (remoteUrl) handleProfileImageError(remoteUrl);
									setProfileImageObjectUrl(null);
								}}
							/>
						)}
					</Show>
					<div class="cap-settings-profile-copy flex h-8 flex-col flex-1 justify-center gap-0.5 min-w-0">
						<p class="h-[15px] truncate text-[13px] leading-[15px] text-gray-12">
							{accountName()}
						</p>
						<p class="h-[13px] truncate text-[11px] leading-[13px] text-gray-10">
							账户
						</p>
					</div>
				</button>
				<ul class="cap-settings-nav min-w-48 h-full p-2.5 space-y-1 text-gray-12">
					<For each={settingsItems}>
						{(item) => (
							<li>
								<A
									href={item.href}
									activeClass="bg-gray-5 pointer-events-none"
									class="cap-settings-nav-item rounded-lg h-8 hover:bg-gray-3 text-[13px] px-2 flex flex-row items-center gap-1.5 transition-colors"
								>
									<item.icon class="opacity-60 size-4" aria-hidden="true" />
									<span>{item.name}</span>
								</A>
							</li>
						)}
					</For>
				</ul>
				<div class="cap-settings-account p-2.5 text-left flex flex-col">
					<Show when={version()}>
						{(v) => (
							<div class="mb-2 text-xs text-gray-11 flex flex-col items-start gap-1.5">
								<span>v{v()}</span>
								<div class="flex flex-col items-start gap-1.5">
									<button
										type="button"
										class="text-gray-11 hover:text-gray-12 underline transition-colors"
										onClick={() =>
											shell.open("https://cap.so/download/versions")
										}
									>
										查看历史版本
									</button>
									<button
										type="button"
										class="text-gray-11 hover:text-gray-12 underline transition-colors disabled:cursor-default disabled:opacity-50 disabled:hover:text-gray-11"
										disabled={isCheckingForUpdates()}
										onClick={checkForUpdates}
									>
										{isCheckingForUpdates() ? "正在检查……" : "检查更新"}
									</button>
								</div>
							</div>
						)}
					</Show>
					<Show
						when={authLoaded()}
						fallback={
							<div class="h-9 w-full rounded-lg bg-gray-4 animate-pulse" />
						}
					>
						{auth() ? (
							<Button onClick={handleAuth} variant="gray" class="w-full">
								退出登录
							</Button>
						) : (
							<SignInButton>登录</SignInButton>
						)}
					</Show>
				</div>
			</div>
			<div class="cap-settings-content overflow-y-hidden flex-1 min-w-0">
				<CapErrorBoundary>
					<Suspense fallback={<SettingsContentSkeleton />}>
						{props.children}
					</Suspense>
				</CapErrorBoundary>
			</div>
		</div>
	);
}
