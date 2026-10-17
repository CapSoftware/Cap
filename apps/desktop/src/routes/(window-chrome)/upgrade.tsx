import { Button } from "@cap/ui-solid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createSignal, onMount, Show } from "solid-js";
import { commands } from "~/utils/tauri";

export default function UpgradeRedirect() {
	const [failed, setFailed] = createSignal(false);
	const openPricing = async () => {
		setFailed(false);
		try {
			await commands.showWindow("Upgrade");
			await getCurrentWindow().close();
		} catch {
			setFailed(true);
		}
	};

	onMount(() => void openPricing());

	return (
		<div class="flex flex-col items-center justify-center gap-3 h-full text-gray-12">
			<Show when={failed()} fallback={<p>正在浏览器中打开价格页面…</p>}>
				<p>无法打开浏览器。请访问 cap.so/pricing 查看各版本。</p>
				<Button variant="gray" onClick={() => void openPricing()}>
					重试
				</Button>
			</Show>
		</div>
	);
}
