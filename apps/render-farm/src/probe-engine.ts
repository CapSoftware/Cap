import type { Engine } from "./engine";

type ProbeProcess = Pick<Engine, "alive" | "request" | "kill">;

export class ProbeEngine {
	private engine?: ProbeProcess;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly create: () => ProbeProcess,
		private readonly timeoutMs = 120_000,
	) {}

	request<T>(body: Record<string, unknown>): Promise<T> {
		const result = this.tail.then(async () => {
			for (let attempt = 0; ; attempt++) {
				if (!this.engine?.alive) this.engine = this.create();
				const engine = this.engine;
				let timedOut = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					return await Promise.race([
						engine.request<T>("probe", body),
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => {
								timedOut = true;
								engine.kill("SIGKILL");
								this.engine = undefined;
								reject(new Error("probe engine timed out"));
							}, this.timeoutMs);
						}),
					]);
				} catch (error) {
					if (attempt > 0 || (!timedOut && engine.alive)) throw error;
				} finally {
					clearTimeout(timer);
				}
			}
		});
		this.tail = result.catch(() => {});
		return result;
	}
}
