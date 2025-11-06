"use client";

import type * as DialogPrimitive from "@radix-ui/react-dialog";
import { type RefObject } from "react";

const isInsideDialog = (el: Element, dialogContent: HTMLElement | null) => {
	if (!dialogContent) return false;
	return dialogContent.contains(el);
};

const isWhitelisted = (el: Element, dialogContent: HTMLElement | null) => {
	if (isInsideDialog(el, dialogContent)) return true;
	if (el.closest('[data-slot="select-content"]')) return true;
	if (el.closest("[data-radix-select-content]")) return true;
	if (el.closest("[data-radix-select-viewport]")) return true;
	if (el.closest("[data-radix-select-item]")) return true;
	if (el.closest("[data-camera-preview]")) return true;
	return false;
};

const shouldPreventDefault = (
	target: Element | null | undefined,
	path: Array<EventTarget>,
	dialogContent: HTMLElement | null,
) => {
	if (!target) return false;

	return (
		isWhitelisted(target, dialogContent) ||
		path.some((t) => t instanceof Element && isWhitelisted(t as Element, dialogContent))
	);
};

interface UseDialogInteractionsOptions {
	dialogContentRef: RefObject<HTMLDivElement | null>;
	isRecording: boolean;
	isBusy: boolean;
}

export const useDialogInteractions = ({
	dialogContentRef,
	isRecording,
	isBusy,
}: UseDialogInteractionsOptions) => {
	const handlePointerDownOutside = (
		event: DialogPrimitive.DialogContentProps["onPointerDownOutside"],
	) => {
		if (!event) return;

		const originalEvent = event.detail.originalEvent;
		const target = originalEvent?.target as Element | null | undefined;

		if (!target) return;

		if (isRecording || isBusy) {
			event.preventDefault();
			return;
		}

		const path = originalEvent?.composedPath() || [];
		const dialogContent = dialogContentRef.current;

		if (shouldPreventDefault(target, path, dialogContent)) {
			event.preventDefault();
		}
	};

	const handleFocusOutside = (
		event: DialogPrimitive.DialogContentProps["onFocusOutside"],
	) => {
		if (!event) return;

		const target = event.target as Element | null | undefined;

		if (!target) return;

		if (isRecording || isBusy) {
			event.preventDefault();
			return;
		}

		const path =
			(event.detail?.originalEvent as FocusEvent)?.composedPath?.() || [];
		const dialogContent = dialogContentRef.current;

		if (shouldPreventDefault(target, path, dialogContent)) {
			event.preventDefault();
		}
	};

	const handleInteractOutside = (
		event: DialogPrimitive.DialogContentProps["onInteractOutside"],
	) => {
		if (!event) return;

		const originalEvent = event.detail.originalEvent;
		const target = originalEvent?.target as Element | null | undefined;

		if (!target) return;

		if (isRecording || isBusy) {
			event.preventDefault();
			return;
		}

		const path = originalEvent?.composedPath?.() || [];
		const dialogContent = dialogContentRef.current;

		if (shouldPreventDefault(target, path, dialogContent)) {
			event.preventDefault();
		}
	};

	return {
		handlePointerDownOutside,
		handleFocusOutside,
		handleInteractOutside,
	};
};

