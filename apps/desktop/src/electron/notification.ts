import { native } from "./bridge";
export type Permission = "granted" | "denied" | "default";
export const isPermissionGranted = () => native<Permission>("notification.permission").then((value) => value === "granted");
export const requestPermission = () => native<Permission>("notification.requestPermission");
export const sendNotification = (options: string | { title: string; body?: string; icon?: string }) =>
	native<void>("notification.show", typeof options === "string" ? { title: options } : options);
export const registerActionTypes = () => Promise.resolve();
export const pending = () => Promise.resolve([]);
export const cancel = () => Promise.resolve();
export const cancelAll = () => Promise.resolve();
export const active = () => Promise.resolve([]);
export const removeActive = () => Promise.resolve();
export const removeAllActive = () => Promise.resolve();
export const createChannel = () => Promise.resolve();
export const deleteChannel = () => Promise.resolve();
export const listChannels = () => Promise.resolve([]);
export const channels = listChannels;
export const onAction = () => Promise.resolve(() => {});
export const onNotificationReceived = () => Promise.resolve(() => {});
