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
			<Show when={failed()} fallback={<p>Opening pricing in your browser…</p>}>
				<p>Couldn't open your browser. Visit cap.so/pricing to view plans.</p>
				<Button variant="gray" onClick={() => void openPricing()}>
					Try again
				</Button>
			</Show>
		</div>
	);
}
