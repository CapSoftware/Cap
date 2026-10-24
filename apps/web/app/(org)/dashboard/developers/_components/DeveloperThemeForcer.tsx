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
		return () => {
			const savedTheme =
				(Cookies.get("theme") as "light" | "dark" | undefined) ??
				previousTheme.current;
			setThemeHandler(savedTheme, { persist: false });
		};
	}, [setThemeHandler]);

	useEffect(() => {
		if (theme !== "dark") {
			setThemeHandler("dark", { persist: false });
		}
	}, [theme, setThemeHandler]);

	return <>{children}</>;
}
