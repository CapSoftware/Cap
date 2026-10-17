"use client";

import clsx from "clsx";
import Cookies from "js-cookie";
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useState,
} from "react";
import { trackEvent } from "@/app/utils/analytics";
import {
	type OnboardingThemePreference,
	resolveOnboardingTheme,
	THEME_COOKIE,
} from "../onboarding-flow";
import { BoilFilter } from "./paper";

const DARK_QUERY = "(prefers-color-scheme: dark)";

const ThemeToggleContext = createContext<(() => void) | null>(null);

export const useToggleOnboardingTheme = () => {
	const toggle = useContext(ThemeToggleContext);
	if (!toggle) throw new Error("useToggleOnboardingTheme needs a PaperRoot");
	return toggle;
};

export const PaperRoot = ({
	children,
	className,
	initialTheme,
}: {
	children: ReactNode;
	className?: string;
	initialTheme: OnboardingThemePreference;
}) => {
	const filterId = `ob-boil-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
	const [preference, setPreference] = useState(initialTheme);

	useEffect(() => {
		const media = window.matchMedia(DARK_QUERY);
		const previous = document.body.className;
		const apply = () => {
			document.body.className = resolveOnboardingTheme(
				preference,
				media.matches,
			);
		};
		apply();
		media.addEventListener("change", apply);
		return () => {
			media.removeEventListener("change", apply);
			document.body.className = previous;
		};
	}, [preference]);

	const toggle = useCallback(() => {
		const current = resolveOnboardingTheme(
			preference,
			window.matchMedia(DARK_QUERY).matches,
		);
		const next = current === "dark" ? "light" : "dark";
		setPreference(next);
		Cookies.set(THEME_COOKIE, next, { expires: 365 });
		trackEvent("onboarding_theme_toggled", { theme: next });
	}, [preference]);

	return (
		<ThemeToggleContext.Provider value={toggle}>
			<div
				className={clsx("cap-ob flex flex-col", className)}
				data-theme={preference}
				style={{ "--ob-boil-filter": `url(#${filterId})` } as CSSProperties}
			>
				<BoilFilter id={filterId} />
				{children}
			</div>
		</ThemeToggleContext.Provider>
	);
};

export const ThemeToggle = () => {
	const toggle = useToggleOnboardingTheme();

	return (
		<button
			type="button"
			onClick={toggle}
			className="ob-theme-toggle ob-focus"
			title="Switch between light and dark"
		>
			<span className="ob-when-light">
				<span className="sr-only">Switch to dark mode</span>
				<svg
					viewBox="0 0 24 24"
					className="ob-boil ob-theme-icon size-[18px] overflow-visible"
					aria-hidden="true"
				>
					<path
						className="ob-ink"
						style={{ strokeWidth: 1.9 }}
						d="M 19.5 14.6 C 18.4 15.1 17.1 15.4 15.8 15.4 C 11 15.4 7.2 11.6 7.2 6.8 C 7.2 5.5 7.5 4.2 8 3.1 C 4.9 4.4 2.8 7.5 2.8 11 C 2.8 15.9 6.8 19.9 11.7 19.9 C 15.2 19.9 18.2 17.7 19.5 14.6 Z"
					/>
					<path
						className="ob-ink is-accent"
						style={{ strokeWidth: 1.7 }}
						d="M 17 3.5 L 17 7.5 M 15 5.5 L 19 5.5"
					/>
				</svg>
			</span>
			<span className="ob-when-dark">
				<span className="sr-only">Switch to light mode</span>
				<svg
					viewBox="0 0 24 24"
					className="ob-boil ob-theme-icon size-[18px] overflow-visible"
					aria-hidden="true"
				>
					<circle
						className="ob-ink"
						style={{ strokeWidth: 1.9 }}
						cx="12"
						cy="12"
						r="4.2"
					/>
					<path
						className="ob-ink"
						style={{ strokeWidth: 1.9 }}
						d="M 12 2.6 L 12 4.6 M 12 19.4 L 12 21.4 M 2.6 12 L 4.6 12 M 19.4 12 L 21.4 12 M 5.4 5.4 L 6.8 6.8 M 17.2 17.2 L 18.6 18.6 M 5.4 18.6 L 6.8 17.2 M 17.2 6.8 L 18.6 5.4"
					/>
				</svg>
			</span>
		</button>
	);
};
