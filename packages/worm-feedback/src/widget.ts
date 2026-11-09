import { type Collector, createCollector } from "./evidence";
import { buildEvidence, MAX_NOTE, reportForm } from "./report";
import { captureScreenshot } from "./screenshot";
import { STYLE } from "./styles";
import type { WormFeedback, WormFeedbackConfig } from "./types";
import {
	MAX_VOICE_MS,
	type VoiceMemo,
	VoiceRecorder,
	voiceSupported,
} from "./voice";

const ICON =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

function origin(server: string): string {
	const url = new URL(server);
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
		throw new Error("Worm feedback needs an https server origin.");
	return url.origin;
}

const clock = (ms: number) => {
	const seconds = Math.floor(ms / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
	...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	Object.assign(node, props);
	node.append(...children);
	return node;
}

export function mountWidget(config: WormFeedbackConfig): WormFeedback {
	const server = origin(config.server);
	if (!config.siteKey) throw new Error("Worm feedback needs a site key.");
	const send = window.fetch.bind(window);
	const host = document.createElement("worm-feedback");
	host.setAttribute("data-worm-mask", "");
	host.className = "ph-no-capture rr-block sentry-block fs-exclude";
	host.setAttribute("data-private", "");
	const root = host.attachShadow({ mode: "open" });
	const sheet = element("style", { textContent: STYLE });
	const frame = element("div", {
		className: config.position === "bottom-left" ? "left" : "right",
	});
	const collector: Collector = createCollector({
		host: () => host,
		ignoreOrigin: server,
		routeRules: config.routeRules,
		requestIdHeaders: config.requestIdHeaders,
		genericTestids: config.genericTestids,
	});

	const launcher = element("button", {
		className: "launcher",
		type: "button",
		ariaLabel: config.label ?? "Send feedback",
	});
	launcher.setAttribute("aria-haspopup", "dialog");
	launcher.setAttribute("aria-expanded", "false");
	launcher.innerHTML = ICON;
	launcher.append(element("span", { textContent: config.label ?? "Feedback" }));

	const titleId = "worm-feedback-title";
	const panel = element("div", { className: "panel", hidden: true });
	panel.setAttribute("role", "dialog");
	panel.setAttribute("aria-labelledby", titleId);
	const close = element("button", {
		className: "close",
		type: "button",
		ariaLabel: "Close feedback",
		textContent: "×",
	});
	const note = element("textarea", {
		id: "worm-feedback-note",
		maxLength: MAX_NOTE,
		placeholder: "What happened? What did you expect?",
	});
	const screenshotButton = element("button", {
		className: "tool",
		type: "button",
		textContent: "Add screenshot",
	});
	const voiceButton = element("button", {
		className: "tool",
		type: "button",
		textContent: "Record voice memo",
	});
	voiceButton.setAttribute("aria-pressed", "false");
	if (!voiceSupported()) voiceButton.hidden = true;
	const shotRow = element("div", { className: "attachment", hidden: true });
	const voiceRow = element("div", { className: "attachment", hidden: true });
	const status = element("p", { className: "status" });
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	const sendButton = element("button", {
		className: "send",
		type: "button",
		textContent: "Send feedback",
		disabled: true,
	});
	panel.append(
		element(
			"div",
			{ className: "head" },
			element("h2", { id: titleId, textContent: "Send feedback" }),
			close,
		),
		element("label", { htmlFor: note.id, textContent: "Your note" }),
		note,
		element("div", { className: "tools" }, screenshotButton, voiceButton),
		shotRow,
		voiceRow,
		element("p", {
			className: "privacy",
			textContent: `Sent only to ${new URL(server).host}. Typed fields are hidden in screenshots.`,
		}),
		status,
		sendButton,
	);
	frame.append(launcher, panel);
	root.append(sheet, frame);

	let screenshot: Blob | null = null;
	let shotUrl = "";
	let voice: VoiceMemo | null = null;
	let voiceUrl = "";
	let recorder: VoiceRecorder | null = null;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let sending = false;
	let starting = false;
	let capturing = false;
	let draft = 0;

	const setStatus = (text: string, kind: "" | "error" | "ok" = "") => {
		status.textContent = text;
		status.className = `status${kind ? ` ${kind}` : ""}`;
	};
	const refresh = () => {
		sendButton.disabled =
			sending ||
			capturing ||
			!!recorder ||
			(!note.value.trim() && !screenshot && !voice);
		screenshotButton.disabled = sending || capturing;
		voiceButton.disabled = sending || starting;
	};
	const clearScreenshot = () => {
		if (shotUrl) URL.revokeObjectURL(shotUrl);
		screenshot = null;
		shotUrl = "";
		shotRow.hidden = true;
		shotRow.replaceChildren();
		screenshotButton.textContent = "Add screenshot";
		refresh();
	};
	const clearVoice = () => {
		if (voiceUrl) URL.revokeObjectURL(voiceUrl);
		voice = null;
		voiceUrl = "";
		voiceRow.hidden = true;
		voiceRow.replaceChildren();
		refresh();
	};
	const removeButton = (label: string, action: () => void) => {
		const button = element("button", {
			className: "remove",
			type: "button",
			textContent: "Remove",
			ariaLabel: label,
		});
		button.addEventListener("click", action);
		return button;
	};

	screenshotButton.addEventListener("click", async () => {
		setStatus("Taking screenshot…");
		const generation = draft;
		capturing = true;
		refresh();
		try {
			const blob = await captureScreenshot(host);
			if (generation !== draft) return;
			clearScreenshot();
			screenshot = blob;
			shotUrl = URL.createObjectURL(blob);
			shotRow.replaceChildren(
				element("img", { src: shotUrl, alt: "Screenshot preview" }),
				element("span", { className: "grow", textContent: "Screenshot added" }),
				removeButton("Remove screenshot", clearScreenshot),
			);
			shotRow.hidden = false;
			screenshotButton.textContent = "Retake screenshot";
			setStatus("");
		} catch {
			if (generation === draft)
				setStatus("Couldn't take a screenshot on this page.", "error");
		} finally {
			capturing = false;
			refresh();
		}
	});

	const stopRecording = async () => {
		if (!recorder) return;
		const active = recorder;
		clearInterval(ticker);
		try {
			voice = await active.stop();
			voiceUrl = URL.createObjectURL(voice.blob);
			const audio = element("audio", { src: voiceUrl, controls: true });
			voiceRow.replaceChildren(
				audio,
				removeButton("Remove voice memo", clearVoice),
			);
			voiceRow.hidden = false;
			setStatus("");
		} catch {
			setStatus("The voice memo could not be saved.", "error");
		} finally {
			recorder = null;
			voiceButton.textContent = "Record voice memo";
			voiceButton.setAttribute("aria-pressed", "false");
			voiceButton.classList.remove("recording");
			refresh();
		}
	};
	voiceButton.addEventListener("click", async () => {
		if (recorder) return stopRecording();
		clearVoice();
		const next = new VoiceRecorder(() => {
			stopRecording();
		});
		recorder = next;
		starting = true;
		refresh();
		try {
			await next.start();
		} catch {
			if (recorder === next) {
				recorder = null;
				setStatus(
					"Microphone is unavailable. You can still type a note.",
					"error",
				);
			}
			return;
		} finally {
			starting = false;
			refresh();
		}
		if (recorder !== next) {
			next.cancel();
			return;
		}
		voiceButton.setAttribute("aria-pressed", "true");
		voiceButton.classList.add("recording");
		const tick = () => {
			voiceButton.textContent = `Stop recording ${clock(next.elapsedMs)} / ${clock(MAX_VOICE_MS)}`;
		};
		tick();
		ticker = setInterval(tick, 500);
	});

	note.addEventListener("input", () => {
		if (status.classList.contains("ok")) setStatus("");
		refresh();
	});

	const reset = () => {
		draft++;
		note.value = "";
		clearScreenshot();
		clearVoice();
	};

	sendButton.addEventListener("click", async () => {
		if (sendButton.disabled) return;
		sending = true;
		refresh();
		setStatus("Sending…");
		try {
			const evidence = await buildEvidence(collector, {
				getContext: config.getContext,
				posthog: config.posthog,
				voice,
			});
			const response = await send(`${server}/api/v1/feedback`, {
				method: "POST",
				body: reportForm({
					siteKey: config.siteKey,
					note: note.value,
					evidence,
					screenshot,
					voice,
				}),
				credentials: "omit",
				mode: "cors",
				referrerPolicy: "no-referrer",
			});
			if (!response.ok) throw new Error(String(response.status));
			reset();
			setStatus("Thanks. Your feedback was sent.", "ok");
		} catch {
			setStatus("Couldn't send. Your note is still here; try again.", "error");
		} finally {
			sending = false;
			refresh();
		}
	});

	const viewport = window.visualViewport;
	const fitKeyboard = () => {
		if (!viewport) return;
		const keyboard = Math.max(
			0,
			window.innerHeight - viewport.height - viewport.offsetTop,
		);
		host.style.setProperty("--wf-kb", `${Math.round(keyboard)}px`);
		host.style.setProperty("--wf-vh", `${Math.round(viewport.height)}px`);
	};
	viewport?.addEventListener("resize", fitKeyboard);
	viewport?.addEventListener("scroll", fitKeyboard);

	const open = () => {
		panel.hidden = false;
		launcher.hidden = true;
		launcher.setAttribute("aria-expanded", "true");
		fitKeyboard();
		if (!status.classList.contains("ok")) setStatus("");
		note.focus();
	};
	const hide = () => {
		if (recorder) {
			recorder.cancel();
			recorder = null;
			clearInterval(ticker);
			voiceButton.textContent = "Record voice memo";
			voiceButton.setAttribute("aria-pressed", "false");
			voiceButton.classList.remove("recording");
		}
		panel.hidden = true;
		launcher.hidden = false;
		launcher.setAttribute("aria-expanded", "false");
		launcher.focus();
		refresh();
	};
	launcher.addEventListener("click", open);
	close.addEventListener("click", hide);
	panel.addEventListener("keydown", (event) => {
		if (event.key === "Escape") hide();
	});

	document.body.append(host);

	return {
		open,
		close: hide,
		destroy: () => {
			hide();
			reset();
			collector.stop();
			viewport?.removeEventListener("resize", fitKeyboard);
			viewport?.removeEventListener("scroll", fitKeyboard);
			host.remove();
		},
	};
}
