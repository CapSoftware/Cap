import { native } from "./bridge";

export interface DialogFilter {
	name: string;
	extensions: string[];
}
export interface OpenDialogOptions {
	title?: string;
	filters?: DialogFilter[];
	defaultPath?: string;
	multiple?: boolean;
	directory?: boolean;
	recursive?: boolean;
	canCreateDirectories?: boolean;
}
export interface SaveDialogOptions {
	title?: string;
	filters?: DialogFilter[];
	defaultPath?: string;
}
export interface MessageDialogOptions {
	title?: string;
	kind?: "info" | "warning" | "error";
	okLabel?: string;
	buttons?: string[] | Record<string, string | undefined>;
}
export interface ConfirmDialogOptions extends MessageDialogOptions {
	cancelLabel?: string;
}

export function open(options: OpenDialogOptions = {}) {
	return native<string | string[] | null>("dialog.open", { ...options });
}
export function save(options: SaveDialogOptions = {}) {
	return native<string | null>("dialog.save", { ...options });
}
export function message(
	message_: string,
	options: string | MessageDialogOptions = {},
) {
	return native<string | undefined>("dialog.message", {
		message: message_,
		...(typeof options === "string" ? { title: options } : options),
	});
}
export function ask(
	message_: string,
	options: string | ConfirmDialogOptions = {},
) {
	return native<boolean>("dialog.ask", {
		message: message_,
		...(typeof options === "string" ? { title: options } : options),
	});
}
export function confirm(
	message_: string,
	options: string | ConfirmDialogOptions = {},
) {
	return native<boolean>("dialog.confirm", {
		message: message_,
		...(typeof options === "string" ? { title: options } : options),
	});
}
