export const CAP_WEB_ORIGIN =
	import.meta.env.VITE_CAP_WEB_ORIGIN ||
	import.meta.env.VITE_SERVER_URL ||
	"https://cap.so";

export const capWebUrl = (path: string) =>
	new URL(path, CAP_WEB_ORIGIN).toString();
