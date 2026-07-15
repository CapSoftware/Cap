import { useNavigate } from "@solidjs/router";
import { createQuery } from "@tanstack/solid-query";
import { getVersion } from "@tauri-apps/api/app";
import * as dialog from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { createSignal, createUniqueId, For, onMount } from "solid-js";
import { commands } from "~/utils/tauri";

export default function Debug() {
	const navigate = useNavigate();
	const [version, setVersion] = createSignal<string>("");
	const [updateStatus, setUpdateStatus] = createSignal<string>("");
	const [isChecking, setIsChecking] = createSignal(false);

	onMount(async () => {
		const v = await getVersion();
		setVersion(v);
	});

	const checkForUpdates = async () => {
		setIsChecking(true);
		setUpdateStatus("正在检查...");
		try {
			const update = await check();
			if (update) {
				setUpdateStatus(`发现可用更新：v${update.version}`);
			} else {
				setUpdateStatus("暂无可用更新");
			}
		} catch (e) {
			setUpdateStatus(`错误：${e}`);
		}
		setIsChecking(false);
	};

	const simulateUpdatePopup = async () => {
		const fakeVersion = "99.0.0";
		setUpdateStatus(`正在模拟更新至 v${fakeVersion}...`);

		const shouldUpdate = await dialog.confirm(
			`Cap ${fakeVersion} 版本可用，是否安装？`,
			{ title: "更新 Cap", okLabel: "更新", cancelLabel: "忽略" },
		);

		if (shouldUpdate) {
			navigate("/update");
		} else {
			setUpdateStatus("用户已拒绝更新");
		}
	};

	const fails = createQuery(() => ({
		queryKey: ["fails"],
		queryFn: () => commands.listFails(),
	}));

	const orderedFails = () => Object.entries(fails.data ?? {});

	return (
		<main class="w-full h-full bg-gray-2 text-(--text-primary) p-4">
			<h2 class="text-2xl font-bold">调试窗口</h2>
			<div class="p-2 mb-4">
				<button
					class="bg-blue-500 hover:bg-blue-600 text-white font-medium py-2 px-4 rounded-sm"
					onClick={() => commands.showWindow("Onboarding")}
				>
					显示引导窗口
				</button>
				<button
					class="bg-blue-500 hover:bg-blue-600 text-white font-medium py-2 px-4 rounded-sm"
					onClick={() =>
						commands.showWindow({ InProgressRecording: { countdown: 3 } })
					}
				>
					显示录制控制窗口
				</button>
			</div>

			<h2 class="text-2xl font-bold mt-4">更新</h2>
			<div class="p-2 mb-4">
				<p class="mb-2 text-sm text-(--text-secondary)">
					当前版本：v{version()}
				</p>
				<div class="flex flex-row gap-2 items-center">
					<button
						class="bg-blue-500 hover:bg-blue-600 text-white font-medium py-2 px-4 rounded-sm disabled:opacity-50"
						onClick={checkForUpdates}
						disabled={isChecking()}
					>
						检查更新
					</button>
					<button
						class="bg-green-500 hover:bg-green-600 text-white font-medium py-2 px-4 rounded-sm"
						onClick={() => navigate("/update")}
					>
						前往更新页面
					</button>
					<button
						class="bg-purple-500 hover:bg-purple-600 text-white font-medium py-2 px-4 rounded-sm disabled:opacity-50"
						onClick={simulateUpdatePopup}
						disabled={isChecking()}
					>
						模拟更新流程
					</button>
				</div>
				{updateStatus() && <p class="mt-2 text-sm">{updateStatus()}</p>}
			</div>

			<h2 class="text-2xl font-bold mt-4">故障点</h2>
			<ul class="p-2">
				<For each={orderedFails()}>
					{(fail) => {
						const id = createUniqueId();

						return (
							<li class="flex flex-row items-center gap-2">
								<input
									class="size-4"
									id={id}
									type="checkbox"
									checked={fail[1]}
									value={fail[1].toString()}
									onClick={(e) => {
										e.preventDefault();
										commands
											.setFail(fail[0], !fail[1])
											.then(() => fails.refetch());
									}}
								/>
								<label for={id}>{fail[0]}</label>
							</li>
						);
					}}
				</For>
			</ul>
		</main>
	);
}
