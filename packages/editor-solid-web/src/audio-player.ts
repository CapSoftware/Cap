import { parseEditorAudioPacket } from "./audio-packets";

const processorUrl = new URL("./audio-processor.js", import.meta.url).href;

export class WebEditorAudio {
	private context: AudioContext | null = null;
	private node: AudioWorkletNode | null = null;
	private ready: Promise<void> | null = null;
	private closed = false;

	private async prepare() {
		if (this.node) return;
		const context = new AudioContext({
			latencyHint: "interactive",
			sampleRate: 48_000,
		});
		this.context = context;
		const resume = context.resume();
		try {
			await context.audioWorklet.addModule(processorUrl);
			await resume;
			if (this.closed) return;
			const node = new AudioWorkletNode(context, "cap-editor-audio", {
				outputChannelCount: [2],
			});
			node.connect(context.destination);
			this.node = node;
		} catch (error) {
			this.context = null;
			await context.close();
			throw error;
		}
	}

	async start() {
		if (this.closed) throw new Error("Editor audio is closed");
		this.ready ??= this.prepare();
		try {
			await this.ready;
		} catch (error) {
			this.ready = null;
			throw error;
		}
		if (this.closed) throw new Error("Editor audio is closed");
		this.node?.port.postMessage({ kind: "reset" });
		await this.context?.resume();
	}

	push(packet: ArrayBuffer) {
		if (!this.node || !parseEditorAudioPacket(packet)) return;
		this.node.port.postMessage({ kind: "audio", packet }, [packet]);
	}

	stop() {
		this.node?.port.postMessage({ kind: "reset" });
		void this.context?.suspend();
	}

	reset() {
		this.node?.port.postMessage({ kind: "reset" });
	}

	dispose() {
		if (this.closed) return;
		this.closed = true;
		this.node?.disconnect();
		this.node = null;
		void this.context?.close();
		this.context = null;
	}
}
