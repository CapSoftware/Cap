import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function classNames(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export const uuidParse = (uuid: string) => {
	return uuid.replace(/-/g, "");
};

export const uuidFormat = (uuid: string) => {
	return uuid.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
};

export const CAP_LOGO_URL =
	"https://raw.githubusercontent.com/CapSoftware/cap/main/apps/desktop/src-tauri/icons/Square310x310Logo.png";

export const saveLatestVideoId = (videoId: string) => {
	try {
		if (typeof navigator !== "undefined" && typeof window !== "undefined") {
			window.localStorage.setItem("latestVideoId", videoId);
		}
	} catch (error) {
		console.error(error);
	}
};

export const getLatestVideoId = () => {
	if (typeof navigator !== "undefined" && typeof window !== "undefined") {
		return window.localStorage.getItem("latestVideoId") || "";
	}

	return "";
};

export const saveUserId = async (userId: string) => {
	try {
		if (typeof navigator !== "undefined" && typeof window !== "undefined") {
			window.localStorage.setItem("userId", userId);
		}
	} catch (error) {
		console.error(error);
	}
};

export const getUserId = async () => {
	if (typeof navigator !== "undefined" && typeof window !== "undefined") {
		return window.localStorage.getItem("userId") || "";
	}

	return "";
};

export const isUserPro = async () => {
	if (typeof navigator !== "undefined" && typeof window !== "undefined") {
		return window.localStorage.getItem("pro") || false;
	}

	return false;
};

export const getProgressCircleConfig = () => {
	const radius = 8;
	const circumference = 2 * Math.PI * radius;

	return { radius, circumference };
};

export const calculateStrokeDashoffset = (
	progress: number,
	circumference: number,
) => {
	return circumference - (progress / 100) * circumference;
};

export const getDisplayProgress = (
	uploadProgress?: number,
	processingProgress: number = 0,
) => {
	return uploadProgress !== undefined ? uploadProgress : processingProgress;
};

export function isEmailAllowedByRestriction(
	email: string,
	restriction: string,
): boolean {
	const entries = restriction
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);

	if (entries.length === 0) return true;

	const lowerEmail = email.toLowerCase();

	return entries.some((entry) => {
		if (entry.includes("@")) {
			return lowerEmail === entry;
		}
		return lowerEmail.endsWith(`@${entry}`);
	});
}
