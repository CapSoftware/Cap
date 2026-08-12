import { native } from "./bridge";
export const openPath = (path: string) => native<string>("opener.openPath", { path });
export const openUrl = (url: string) => native<void>("shell.open", { path: url });
export const revealItemInDir = (path: string) => native<void>("opener.revealItemInDir", { path });
