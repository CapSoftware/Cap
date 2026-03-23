"use client";

import Cookies from "js-cookie";
import { useEffect, useRef } from "react";
import { useTheme } from "../../Contexts";

export function DeveloperThemeForcer({
	children,
}: {
	children: React.ReactNode;
}) {
	const { theme, setThemeHandler } = useTheme();
	const previousTheme = useRef<"light" | "dark">(
		(Cookies.get("theme") as "light" | "dark") ?? "light",
	);

	useEffect(() => {
		if (theme !== "dark") {
			setThemeHandler("dark");
		}
	}, [theme, setThemeHandler]);

	useEffect(() => {
		const saved = previousTheme.current;
		return () => {
			if (saved !== "dark") {
				document.body.className = saved;
				Cookies.set("theme", saved, { expires: 365 });
			}
		};
	}, []);

	return <>{children}</>;
}
