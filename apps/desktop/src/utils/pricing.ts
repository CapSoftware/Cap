import toast from "solid-toast";
import { commands } from "./tauri";

export async function openPricingPage() {
	try {
		await commands.showWindow("Upgrade");
	} catch {
		toast.error(
			"无法打开浏览器。请访问 cap.so/pricing 查看各版本。",
		);
	}
}
