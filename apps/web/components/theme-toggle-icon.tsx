"use client";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/app/(org)/dashboard/Contexts";

export const ThemeToggleIcon = () => {
	const { theme } = useTheme();

	return (
		<button
			type="button"
			className="view-transition-theme-icon"
			aria-label={
				theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
			}
		>
			{theme === "dark" ? (
				<Moon size={17} className="fill-white stroke-gray-3" />
			) : (
				<Sun size={17} className="stroke-gray-12" />
			)}
		</button>
	);
};
