"use client";

import { useEffect, useState } from "react";
import { Toaster } from "sonner";

type Theme = "light" | "dark" | "system";

export function SonnerToaster() {
	const [theme, setTheme] = useState<Theme>("light");

	useEffect(() => {
		const updateTheme = () => {
			const classes = document.body.classList;
			setTheme(
				classes.contains("dark")
					? "dark"
					: classes.contains("system")
						? "system"
						: "light",
			);
		};
		const observer = new MutationObserver(updateTheme);
		observer.observe(document.body, {
			attributes: true,
			attributeFilter: ["class"],
		});
		updateTheme();

		return () => observer.disconnect();
	}, []);

	return <Toaster position="top-center" theme={theme} richColors />;
}
