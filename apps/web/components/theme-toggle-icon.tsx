"use client";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/app/(org)/dashboard/Contexts";

export const ThemeToggleIcon = () => {
	const { theme } = useTheme();

	return (
		<span className="view-transition-theme-icon">
			{theme === "dark" ? (
				<Moon size={17} className="fill-white stroke-gray-3" />
			) : (
				<Sun size={17} className="stroke-gray-12" />
			)}
		</span>
	);
};
