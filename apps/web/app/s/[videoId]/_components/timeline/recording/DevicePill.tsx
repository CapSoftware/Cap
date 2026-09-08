"use client";

import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from "@cap/ui";

/**
 * Compact device picker for the recorder bars/panels: icon + truncated label
 * + native dropdown, matching the pill styling of the surfaces it sits in.
 * Fed by the same enumeration and preference system as the dashboard web
 * recorder's selectors.
 */
export function DevicePill({
	kind,
	devices,
	selectedId,
	onSelect,
	disabled = false,
	title,
	className = "",
}: {
	kind: "camera" | "mic";
	devices: MediaDeviceInfo[];
	selectedId: string | null;
	onSelect: (deviceId: string) => void;
	disabled?: boolean;
	title?: string;
	className?: string;
}) {
	const fallbackLabel = kind === "camera" ? "Camera" : "Microphone";
	const selected = devices.find((device) => device.deviceId === selectedId);
	const label =
		selected?.label?.trim() ||
		(selectedId ? fallbackLabel : `Default ${fallbackLabel.toLowerCase()}`);

	return (
		<SelectRoot
			value={selectedId ?? ""}
			onValueChange={(value) => {
				if (value) onSelect(value);
			}}
			disabled={disabled || devices.length === 0}
		>
			<SelectTrigger
				aria-label={`Select ${fallbackLabel.toLowerCase()}`}
				title={title ?? label}
				className={`flex h-7 min-w-0 items-center gap-1 rounded-lg border-0 bg-gray-2 px-1.5 text-[11px] text-gray-11 shadow-none ring-1 ring-gray-4 transition-colors hover:bg-gray-3 hover:text-gray-12 focus:ring-gray-5 disabled:cursor-default disabled:opacity-60 [&_.caret-icon]:size-3 [&_.caret-icon]:shrink-0 ${className}`}
			>
				{kind === "camera" ? (
					<svg
						viewBox="0 0 16 16"
						className="size-3.5 shrink-0 fill-current"
						aria-hidden="true"
					>
						<path d="M2.5 4A1.5 1.5 0 0 0 1 5.5v5A1.5 1.5 0 0 0 2.5 12h6a1.5 1.5 0 0 0 1.5-1.5v-1.1l2.9 1.66a.75.75 0 0 0 1.1-.66V5.6a.75.75 0 0 0-1.1-.66L10 6.6V5.5A1.5 1.5 0 0 0 8.5 4h-6Z" />
					</svg>
				) : (
					<svg
						viewBox="0 0 16 16"
						className="size-3.5 shrink-0 fill-current"
						aria-hidden="true"
					>
						<path d="M8 1.5A2.25 2.25 0 0 0 5.75 3.75v3.5a2.25 2.25 0 0 0 4.5 0v-3.5A2.25 2.25 0 0 0 8 1.5Z" />
						<path d="M3.75 6.75a.65.65 0 0 1 1.3 0v.5a2.95 2.95 0 0 0 5.9 0v-.5a.65.65 0 0 1 1.3 0v.5a4.25 4.25 0 0 1-3.6 4.2v1.55h1.6a.65.65 0 0 1 0 1.3h-4.5a.65.65 0 0 1 0-1.3h1.6v-1.55a4.25 4.25 0 0 1-3.6-4.2v-.5Z" />
					</svg>
				)}
				<span className="max-w-24 truncate">{label}</span>
			</SelectTrigger>
			<SelectContent className="z-[80]">
				{devices.map((device, index) => (
					<SelectItem key={device.deviceId} value={device.deviceId}>
						<span className="max-w-56 truncate">
							{device.label?.trim() || `${fallbackLabel} ${index + 1}`}
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</SelectRoot>
	);
}
