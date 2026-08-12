import { listen, type UnlistenFn } from "./event";
export const getCurrent = () => Promise.resolve<string[] | null>(null);
export const onOpenUrl = (
	handler: (urls: string[]) => void,
): Promise<UnlistenFn> =>
	listen<string[]>("deep-link://new-url", ({ payload }) => handler(payload));
export const register = () => Promise.resolve();
export const unregister = () => Promise.resolve();
export const isRegistered = () => Promise.resolve(true);
