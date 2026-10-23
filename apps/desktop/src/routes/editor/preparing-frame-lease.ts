let nextEpoch = 0;

type PreparingTransport = {
	dispose: () => void;
	preserveFrame?: () => boolean;
};

export function createPreparingFrameLease(options: {
	start: (epoch: number) => Promise<string | null>;
	stop: (epoch: number) => Promise<unknown>;
	attach: (url: string, isActive: () => boolean) => PreparingTransport;
	ended: (retainedFrame: boolean) => void;
}) {
	const epoch = ++nextEpoch;
	let active = true;
	let started = false;
	let transport: PreparingTransport | undefined;
	const stop = () => {
		void options.stop(epoch).catch(() => {});
	};
	const terminate = (preserveFrame: boolean) => {
		if (!active) return;
		active = false;
		let retainedFrame = false;
		try {
			retainedFrame = preserveFrame && (transport?.preserveFrame?.() ?? false);
		} catch {}
		transport?.dispose();
		transport = undefined;
		options.ended(retainedFrame);
		stop();
	};
	const close = () => terminate(false);
	return {
		requestEpoch: epoch,
		isActive: () => active,
		close,
		finish: () => terminate(true),
		async start() {
			if (started || !active) return;
			started = true;
			try {
				const url = await options.start(epoch);
				if (!active) {
					stop();
					return;
				}
				if (!url) {
					close();
					return;
				}
				const attached = options.attach(url, () => active);
				if (active) transport = attached;
				else attached.dispose();
			} catch {
				close();
			}
		},
	};
}
