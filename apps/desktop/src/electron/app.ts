import { native } from "./bridge";
export const getName = () => native<string>("app.name");
export const getVersion = () => native<string>("app.version");
export const getTauriVersion = () => Promise.resolve("electron");
export const getIdentifier = () => Promise.resolve("so.cap.desktop");
export const show = () => native<void>("window.action", { action: "show" });
export const hide = () => native<void>("window.action", { action: "hide" });
export const defaultWindowIcon = () => Promise.resolve(null);
