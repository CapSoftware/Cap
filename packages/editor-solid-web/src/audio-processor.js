class CapEditorAudioProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.blocks = [];
		this.offset = 0;
		this.bufferedFrames = 0;
		this.started = false;
		this.port.onmessage = (event) => {
			const message = event.data;
			if (message.kind === "reset") {
				this.blocks = [];
				this.offset = 0;
				this.bufferedFrames = 0;
				this.started = false;
				return;
			}
			if (message.kind !== "audio" || !(message.packet instanceof ArrayBuffer))
				return;
			const samples = new Float32Array(message.packet, 20);
			this.blocks.push(samples);
			this.bufferedFrames += samples.length / 2;
			while (this.bufferedFrames > 16_384 && this.blocks.length > 1) {
				const removed = this.blocks.shift();
				this.bufferedFrames -= removed.length / 2 - this.offset;
				this.offset = 0;
			}
		};
	}

	process(_inputs, outputs) {
		const output = outputs[0];
		if (!output || output.length < 2) return true;
		output[0].fill(0);
		output[1].fill(0);
		if (!this.started && this.bufferedFrames < 2048) return true;
		this.started = true;
		for (let index = 0; index < output[0].length; index++) {
			const block = this.blocks[0];
			if (!block) {
				this.started = false;
				break;
			}
			output[0][index] = block[this.offset * 2];
			output[1][index] = block[this.offset * 2 + 1];
			this.offset++;
			this.bufferedFrames--;
			if (this.offset * 2 >= block.length) {
				this.blocks.shift();
				this.offset = 0;
			}
		}
		return true;
	}
}

registerProcessor("cap-editor-audio", CapEditorAudioProcessor);
