"use client";

import { MonitorIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export const CameraOnlyPrompt = ({
	onAddScreen,
	onRecordCameraOnly,
	onClose,
}: {
	onAddScreen: (dontShowAgain: boolean) => void;
	onRecordCameraOnly: (dontShowAgain: boolean) => void;
	onClose: () => void;
}) => {
	const [dontShowAgain, setDontShowAgain] = useState(false);
	const titleId = useId();
	const checkboxId = useId();
	const addScreenRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		addScreenRef.current?.focus();
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	return (
		<div
			className="rec-fade absolute inset-0 z-30 flex items-center justify-center bg-[var(--rec-scrim)] p-4 backdrop-blur-md"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
		>
			<div className="rec-pop rec-rise relative flex w-[min(420px,100%)] flex-col gap-1.5 p-5">
				<button
					type="button"
					onClick={onClose}
					aria-label="Close"
					className="rec-btn is-ghost is-icon absolute right-2.5 top-2.5 !h-7 !w-7"
				>
					<XIcon className="size-4" aria-hidden />
				</button>
				<span
					className="rec-track mb-2 flex size-9 items-center justify-center rounded-lg"
					data-kind="screen"
				>
					<span className="rec-track-tile flex size-9 items-center justify-center rounded-lg">
						<MonitorIcon className="size-4" aria-hidden />
					</span>
				</span>
				<h2
					id={titleId}
					className="pr-8 text-[16px] font-medium tracking-[-0.01em] text-[var(--rec-text-1)]"
				>
					Recording your camera only
				</h2>
				<p className="text-[14px] leading-relaxed text-[var(--rec-text-2)]">
					Your screen isn't included in this recording. Add it to record your
					screen with your camera on top, or go ahead with just your camera.
				</p>
				<label
					htmlFor={checkboxId}
					className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-[13px] text-[var(--rec-text-2)]"
				>
					<input
						id={checkboxId}
						type="checkbox"
						checked={dontShowAgain}
						onChange={(event) => setDontShowAgain(event.target.checked)}
						className="size-3.5 accent-[var(--rec-accent)]"
					/>
					Don't show this again
				</label>
				<div className="mt-3 flex flex-wrap justify-end gap-2">
					<button
						type="button"
						className="rec-btn"
						onClick={() => onRecordCameraOnly(dontShowAgain)}
					>
						Record camera only
					</button>
					<button
						ref={addScreenRef}
						type="button"
						className="rec-btn is-accent"
						onClick={() => onAddScreen(dontShowAgain)}
					>
						Add screen
					</button>
				</div>
			</div>
		</div>
	);
};
