"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { infraMono, infraSans } from "./fonts";
import { Button } from "./ui";

export function Modal({
	open,
	onOpenChange,
	title,
	description,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: ReactNode;
	children: ReactNode;
}) {
	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-[600] bg-[rgba(2,2,3,0.72)] backdrop-blur-[2px]" />
				<DialogPrimitive.Content
					className={`${infraSans.variable} ${infraMono.variable} fixed left-1/2 top-1/2 z-[601] w-[calc(100%-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-[14px] bg-[#0B0C0E] p-6 text-[#E8ECF4] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.12),0_24px_80px_rgba(0,0,0,0.6)] [font-family:var(--font-infra-sans),system-ui,sans-serif] focus:outline-none`}
				>
					<DialogPrimitive.Title className="m-0 text-[17px] font-medium leading-[1.3] tracking-[-0.02em] text-[#E8ECF4]">
						{title}
					</DialogPrimitive.Title>
					{description ? (
						<DialogPrimitive.Description className="m-0 mt-2 text-pretty text-[14px] leading-[1.55] text-[rgba(232,236,244,0.6)]">
							{description}
						</DialogPrimitive.Description>
					) : (
						<DialogPrimitive.Description className="sr-only">
							{title}
						</DialogPrimitive.Description>
					)}
					<div className="mt-5">{children}</div>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

export function ConfirmDialog({
	open,
	title,
	description,
	confirmLabel,
	loading,
	onConfirm,
	onCancel,
}: {
	open: boolean;
	title: string;
	description?: ReactNode;
	confirmLabel: string;
	loading: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<Modal
			open={open}
			onOpenChange={(next) => {
				if (!next) onCancel();
			}}
			title={title}
			description={description}
		>
			<div className="flex justify-end gap-2">
				<Button variant="quiet" size="sm" onClick={onCancel} disabled={loading}>
					Cancel
				</Button>
				<Button
					variant="danger"
					size="sm"
					onClick={onConfirm}
					loading={loading}
				>
					{confirmLabel}
				</Button>
			</div>
		</Modal>
	);
}
