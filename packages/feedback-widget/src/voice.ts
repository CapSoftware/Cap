export const MAX_VOICE_MS = 120_000;
const CANDIDATES = [
	"audio/webm;codecs=opus",
	"audio/mp4;codecs=mp4a.40.2",
	"audio/mp4",
	"audio/aac",
	"audio/ogg;codecs=opus",
	"audio/webm",
];

export function pickAudioType(
	supported: (type: string) => boolean = (type) =>
		typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
): string {
	return CANDIDATES.find((type) => supported(type)) ?? "";
}

export const baseType = (type: string) =>
	type.split(";")[0]?.trim().toLowerCase() ?? "";

export interface VoiceMemo {
	blob: Blob;
	mimeType: string;
	durationMs: number;
	startedAt: number;
}

export function voiceSupported(): boolean {
	return (
		typeof MediaRecorder !== "undefined" &&
		!!navigator.mediaDevices?.getUserMedia &&
		pickAudioType() !== ""
	);
}

export class VoiceRecorder {
	private recorder?: MediaRecorder;
	private stream?: MediaStream;
	private timer?: ReturnType<typeof setTimeout>;
	private startedAt = 0;
	private chunks: Blob[] = [];
	private done?: Promise<VoiceMemo>;
	private cancelled = false;

	constructor(private readonly onLimit: () => void = () => {}) {}

	get elapsedMs(): number {
		return this.startedAt ? Date.now() - this.startedAt : 0;
	}

	async start(): Promise<void> {
		const mimeType = pickAudioType();
		if (!mimeType)
			throw new Error("Voice memos are not supported in this browser.");
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		if (this.cancelled) {
			for (const track of stream.getTracks()) track.stop();
			throw new Error("Recording was cancelled.");
		}
		this.stream = stream;
		const recorder = new MediaRecorder(this.stream, {
			mimeType,
			audioBitsPerSecond: 48_000,
		});
		this.recorder = recorder;
		this.chunks = [];
		this.done = new Promise((resolve, reject) => {
			recorder.ondataavailable = (event) => {
				if (event.data.size) this.chunks.push(event.data);
			};
			recorder.onerror = () => reject(new Error("Recording failed."));
			recorder.onstop = () => {
				const type = baseType(recorder.mimeType || mimeType);
				resolve({
					blob: new Blob(this.chunks, { type }),
					mimeType: type,
					durationMs: Math.min(this.elapsedMs, MAX_VOICE_MS),
					startedAt: this.startedAt,
				});
			};
		});
		recorder.start(1000);
		this.startedAt = Date.now();
		this.timer = setTimeout(() => {
			this.onLimit();
		}, MAX_VOICE_MS);
	}

	async stop(): Promise<VoiceMemo> {
		clearTimeout(this.timer);
		if (!this.recorder || !this.done) throw new Error("Not recording.");
		if (this.recorder.state !== "inactive") this.recorder.stop();
		try {
			return await this.done;
		} finally {
			this.release();
		}
	}

	cancel(): void {
		this.cancelled = true;
		clearTimeout(this.timer);
		if (this.recorder && this.recorder.state !== "inactive")
			this.recorder.stop();
		this.release();
	}

	private release(): void {
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.stream = undefined;
		this.startedAt = 0;
	}
}
