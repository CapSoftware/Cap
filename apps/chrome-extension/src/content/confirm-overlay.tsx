import { useCallback, useEffect, useRef, useState } from "react";
import { isOverlayMessage } from "../shared/messages";
import { sendServiceWorkerMessage } from "../shared/runtime";
import type { MicrophoneWarningVariant } from "../shared/types";
import { replayStartupMessages } from "./startup-messages";

type ConfirmRequest = {
	requestId: string;
	variant: MicrophoneWarningVariant;
};

const COPY: Record<
	MicrophoneWarningVariant,
	{ title: string; message: string }
> = {
	"no-mic": {
		title: "Record without a microphone?",
		message:
			"No microphone is selected, so this recording won't capture your voice.",
	},
	"no-sound": {
		title: "No sound from your microphone",
		message:
			"We're not detecting any audio from the selected microphone. It may be muted or unplugged.",
	},
};

// Shared confirm prompt shown as a floating overlay in the middle of the
// recorded/active tab before a recording starts. Every start path (the panel
// and the floating bar) routes through the service worker, which blocks on the
// decision reported back here.
export function ConfirmOverlay() {
	const [request, setRequest] = useState<ConfirmRequest | null>(null);
	const requestRef = useRef<ConfirmRequest | null>(null);
	const confirmButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		requestRef.current = request;
	}, [request]);

	const respond = useCallback((current: ConfirmRequest, confirmed: boolean) => {
		setRequest(null);
		void sendServiceWorkerMessage({
			target: "service-worker",
			type: "confirm-result",
			requestId: current.requestId,
			confirmed,
		}).catch(() => undefined);
	}, []);

	useEffect(() => {
		const handleMessage = (
			message: unknown,
			_sender: chrome.runtime.MessageSender,
			sendResponse: (response?: unknown) => void,
		) => {
			if (!isOverlayMessage(message)) return false;
			if (message.type === "overlay-confirm") {
				sendResponse({ ok: true });
				setRequest({ requestId: message.requestId, variant: message.variant });
				return false;
			}
			if (message.type === "overlay-hide") {
				// A teardown while the prompt is open cancels the pending start so
				// the worker is not left waiting on a decision that can't be made.
				const current = requestRef.current;
				if (current) respond(current, false);
				return false;
			}
			return false;
		};

		chrome.runtime.onMessage.addListener(handleMessage);
		replayStartupMessages(handleMessage);
		return () => chrome.runtime.onMessage.removeListener(handleMessage);
	}, [respond]);

	useEffect(() => {
		if (!request) return;
		confirmButtonRef.current?.focus();
		const handleKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				respond(request, false);
			}
		};
		window.addEventListener("keydown", handleKey, true);
		return () => window.removeEventListener("keydown", handleKey, true);
	}, [request, respond]);

	if (!request) return null;

	const { title, message } = COPY[request.variant];

	return (
		<div className="cap-extension-confirm">
			<button
				type="button"
				className="cap-extension-confirm-backdrop"
				aria-label="Cancel"
				onClick={() => respond(request, false)}
			/>
			<div
				className="cap-extension-confirm-card"
				role="alertdialog"
				aria-modal="true"
				aria-label={title}
			>
				<svg
					className="cap-extension-confirm-icon"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<line x1="2" y1="2" x2="22" y2="22" />
					<path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
					<path d="M5 10v2a7 7 0 0 0 12 5" />
					<path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
					<path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
					<line x1="12" y1="19" x2="12" y2="22" />
				</svg>
				<h2 className="cap-extension-confirm-title">{title}</h2>
				<p className="cap-extension-confirm-message">{message}</p>
				<div className="cap-extension-confirm-actions">
					<button
						type="button"
						className="cap-extension-confirm-button is-secondary"
						onClick={() => respond(request, false)}
					>
						Cancel
					</button>
					<button
						ref={confirmButtonRef}
						type="button"
						className="cap-extension-confirm-button is-primary"
						onClick={() => respond(request, true)}
					>
						Start anyway
					</button>
				</div>
			</div>
		</div>
	);
}
