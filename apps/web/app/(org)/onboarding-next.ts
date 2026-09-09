import Cookies from "js-cookie";
import { getSafeNextPath } from "./safe-next";

const COOKIE_NAME = "cap_onboarding_next";
const EXPIRES_DAYS = 1 / 24;

export const rememberOnboardingNextPath = (path: string) => {
	Cookies.set(COOKIE_NAME, path, {
		expires: EXPIRES_DAYS,
		path: "/",
		sameSite: "lax",
		secure: window.location.protocol === "https:",
	});
};

export const consumeOnboardingNextPath = (fallback: string) => {
	const value = Cookies.get(COOKIE_NAME);
	if (value === undefined) return fallback;
	Cookies.remove(COOKIE_NAME, { path: "/" });
	const path = getSafeNextPath(value, window.location.origin);
	return path === "/dashboard" ? fallback : path;
};
