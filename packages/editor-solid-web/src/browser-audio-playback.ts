import type { BrowserEditorSourceCatalog } from "./browser-sources";

type AudioKind = "mic" | "system" | "display";
type AudioRole = "primary" | "overlap";
type SpeedAudioMode = "maintainPitch" | "matchSpeed" | "mute" | null;
type AudioSlot = {
	element: HTMLAudioElement;
	url: string;
	gain: GainNode | null;
	source: MediaElementAudioSourceNode | null;
	fade: number;
};

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function numeric(value: unknown, fallback: number) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function volumeFromDb(db: number) {
	return db <= -30 ? 0 : 10 ** (db / 20);
}

function slotKey(role: AudioRole, kind: AudioKind) {
	return `${role}:${kind}`;
}

function releaseSlot(slot: AudioSlot) {
	slot.element.pause();
	slot.element.removeAttribute("src");
	slot.element.load();
	slot.element.remove();
	slot.source?.disconnect();
	slot.gain?.disconnect();
}

export class BrowserAudioPlayback {
	private readonly slots = new Map<string, AudioSlot>();
	private readonly unavailableUrls = new Set<string>();
	private readonly host = document.createElement("div");
	private context: AudioContext | null = null;
	private disposed = false;
	private muted = false;
	private micGain = 1;
	private systemGain = 1;

	constructor(
		private readonly catalog: BrowserEditorSourceCatalog,
		private readonly onError: (error: Error) => void,
	) {
		this.host.style.cssText =
			"position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none";
		document.body.append(this.host);
	}

	setConfig(config: unknown) {
		const audio = record(record(config)?.audio);
		this.muted = audio?.mute === true;
		this.micGain = volumeFromDb(numeric(audio?.micVolumeDb, 0));
		this.systemGain = volumeFromDb(numeric(audio?.systemVolumeDb, 0));
		for (const [key, slot] of this.slots) {
			const kind = key.split(":")[1];
			const gain = kind === "mic" ? this.micGain : this.systemGain;
			if (slot.gain) slot.gain.gain.value = this.muted ? 0 : gain * slot.fade;
		}
	}

	resume() {
		if (this.disposed) return;
		if (!this.context) {
			this.context = new AudioContext({ latencyHint: "interactive" });
			for (const [key, slot] of this.slots) this.connect(key, slot);
		}
		void this.context.resume().catch((cause: unknown) => {
			this.onError(cause instanceof Error ? cause : new Error(String(cause)));
		});
		for (const slot of this.slots.values()) {
			void slot.element.play().catch((cause: unknown) => {
				if (!this.disposed && this.slotsHas(slot)) {
					if (
						slot.element.error?.code === 4 ||
						(cause instanceof DOMException &&
							cause.name === "NotSupportedError")
					) {
						this.markUnavailable(slot.url);
						return;
					}
					this.onError(
						cause instanceof Error ? cause : new Error(String(cause)),
					);
				}
			});
		}
	}

	private slotsHas(slot: AudioSlot) {
		return [...this.slots.values()].includes(slot);
	}

	markUnavailable(url: string) {
		this.unavailableUrls.add(url);
		for (const [key, slot] of this.slots) {
			if (slot.url !== url) continue;
			releaseSlot(slot);
			this.slots.delete(key);
		}
	}

	private connect(key: string, slot: AudioSlot) {
		if (!this.context || slot.gain) return;
		const source = this.context.createMediaElementSource(slot.element);
		const gain = this.context.createGain();
		const kind = key.split(":")[1];
		gain.gain.value = this.muted
			? 0
			: kind === "mic"
				? this.micGain
				: this.systemGain;
		source.connect(gain).connect(this.context.destination);
		slot.gain = gain;
		slot.source = source;
	}

	private slot(role: AudioRole, kind: AudioKind, url: string) {
		const key = slotKey(role, kind);
		let slot = this.slots.get(key);
		if (slot?.url === url) return slot;
		if (slot) releaseSlot(slot);
		const element = document.createElement("audio");
		element.preload = "auto";
		element.crossOrigin = "anonymous";
		element.src = url;
		this.host.append(element);
		slot = { element, url, gain: null, source: null, fade: 1 };
		this.slots.set(key, slot);
		this.connect(key, slot);
		return slot;
	}

	private async syncTrack(
		role: AudioRole,
		kind: AudioKind,
		url: string | null,
		time: number,
		playing: boolean,
		speed: number,
		mode: SpeedAudioMode,
		fade: number,
	) {
		const key = slotKey(role, kind);
		if (!url || !Number.isFinite(time) || time < 0) {
			const slot = this.slots.get(key);
			if (slot) {
				releaseSlot(slot);
				this.slots.delete(key);
			}
			return;
		}
		if (this.unavailableUrls.has(url)) return;
		const slot = this.slot(role, kind, url);
		slot.fade = Math.max(0, Math.min(fade, 2));
		const audio = slot.element;
		try {
			const clampedTime = Number.isFinite(audio.duration)
				? Math.min(time, Math.max(audio.duration - 0.001, 0))
				: time;
			if (Math.abs(audio.currentTime - clampedTime) > (playing ? 0.12 : 0.01)) {
				audio.currentTime = clampedTime;
			}
			audio.playbackRate = speed;
			if ("preservesPitch" in audio) {
				audio.preservesPitch = mode !== "matchSpeed";
			}
			const baseGain = kind === "mic" ? this.micGain : this.systemGain;
			if (slot.gain) {
				slot.gain.gain.value = this.muted ? 0 : baseGain * slot.fade;
			}
			if (playing) {
				if (audio.paused) await audio.play();
			} else if (!audio.paused) {
				audio.pause();
			}
		} catch (cause) {
			if (
				audio.error?.code === 4 ||
				(cause instanceof DOMException && cause.name === "NotSupportedError")
			) {
				this.markUnavailable(url);
				return;
			}
			throw cause;
		}
	}

	async sync(
		segmentIndex: number,
		role: AudioRole,
		displayTime: number,
		micTime: number,
		systemTime: number,
		playing: boolean,
		speed: number,
		mode: SpeedAudioMode,
		enabled: boolean,
		fade: number,
		signal: AbortSignal,
	) {
		if (this.disposed || signal.aborted) return;
		const current = await this.catalog.snapshot(signal);
		if (this.disposed || signal.aborted) return;
		const segment = current.segments[segmentIndex];
		if (!segment) throw new Error("Editor audio clip is unavailable");
		const displayAudio =
			segmentIndex === 0 ? current.displayHasAudio : segment.hasAudio;
		await Promise.all([
			this.syncTrack(
				role,
				"display",
				enabled && displayAudio ? (segment.display?.url ?? null) : null,
				displayTime,
				playing,
				speed,
				mode,
				fade,
			),
			this.syncTrack(
				role,
				"mic",
				enabled && segmentIndex === 0 ? (current.mic?.url ?? null) : null,
				micTime,
				playing,
				speed,
				mode,
				fade,
			),
			this.syncTrack(
				role,
				"system",
				enabled && segmentIndex === 0
					? (current.systemAudio?.url ?? null)
					: null,
				systemTime,
				playing,
				speed,
				mode,
				fade,
			),
		]);
	}

	pause() {
		for (const slot of this.slots.values()) slot.element.pause();
	}

	releaseOverlaps() {
		for (const [key, slot] of this.slots) {
			if (!key.startsWith("overlap:")) continue;
			releaseSlot(slot);
			this.slots.delete(key);
		}
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.pause();
		for (const slot of this.slots.values()) releaseSlot(slot);
		this.slots.clear();
		this.host.remove();
		void this.context?.close();
		this.context = null;
	}
}
