type Viewport = {
	position: number;
	zoom: number;
};

export class PlaybackFollow {
	private previous: Viewport | undefined;
	private resumeAt = 0;

	reset() {
		this.previous = undefined;
		this.resumeAt = 0;
	}

	update(
		viewport: Viewport,
		playhead: number,
		duration: number,
		now: number,
		interacting: boolean,
	) {
		const { position, zoom } = viewport;
		if (
			interacting ||
			(this.previous &&
				(this.previous.position !== position || this.previous.zoom !== zoom))
		) {
			this.resumeAt = now + 1000;
		}
		let next = position;
		if (
			now >= this.resumeAt &&
			Number.isFinite(position) &&
			Number.isFinite(zoom) &&
			Number.isFinite(playhead) &&
			Number.isFinite(duration) &&
			zoom > 0 &&
			duration > 0
		) {
			if (playhead < position) {
				next = playhead - zoom * 0.2;
			} else if (playhead > position + zoom * 0.8) {
				next = playhead - zoom * 0.8;
			}
			next = Math.min(Math.max(next, 0), Math.max(duration - zoom, 0));
		}
		this.previous = { position: next, zoom };
		return next;
	}
}
