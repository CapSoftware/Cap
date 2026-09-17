"use client";

import { useEffect, useState } from "react";
import { Toaster } from "sonner";

export function SonnerToaster() {
	const [theme, setTheme] = useState<"light" | "dark">("light");

	useEffect(() => {
		const syncTheme = () => {
			setTheme(document.body.classList.contains("dark") ? "dark" : "light");
		};
		const observer = new MutationObserver(syncTheme);
		observer.observe(document.body, {
			attributes: true,
			attributeFilter: ["class"],
		});
		syncTheme();
		return () => observer.disconnect();
	}, []);

	return <Toaster position="top-center" theme={theme} richColors />;
}
