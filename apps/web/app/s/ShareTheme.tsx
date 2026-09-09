"use client";

import Cookies from "js-cookie";
import { useEffect } from "react";

export function ShareTheme() {
	useEffect(() => {
		const preference = window.matchMedia("(prefers-color-scheme: dark)");
		const applyTheme = () => {
			const savedTheme = Cookies.get("theme");
			const theme =
				savedTheme === "dark" || savedTheme === "light"
					? savedTheme
					: preference.matches
						? "dark"
						: "light";
			document.body.classList.remove("light", "dark");
			document.body.classList.add(theme);
		};
		applyTheme();
		preference.addEventListener("change", applyTheme);
		window.addEventListener("focus", applyTheme);
		return () => {
			preference.removeEventListener("change", applyTheme);
			window.removeEventListener("focus", applyTheme);
			document.body.classList.remove("dark");
			document.body.classList.add("light");
		};
	}, []);
	return null;
}
