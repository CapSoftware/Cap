import { expect, test } from "bun:test";
import { ProbeEngine } from "./probe-engine";

test("a process exit retries on a fresh engine and later jobs keep working", async () => {
	let processes = 0;
	const pool = new ProbeEngine(() => {
		const index = processes++;
		let alive = true;
		return {
			get alive() {
				return alive;
			},
			async request<T>() {
				if (index === 0) {
					alive = false;
					throw new Error("process exited");
				}
				return { frames: 30 } as T;
			},
			kill() {
				alive = false;
			},
		};
	});
	expect(await pool.request<{ frames: number }>({})).toEqual({ frames: 30 });
	expect(await pool.request<{ frames: number }>({})).toEqual({ frames: 30 });
	expect(processes).toBe(2);
});

test("a hung probe is killed, retry is bounded, and the next job gets a fresh process", async () => {
	let processes = 0;
	let killed = 0;
	const pool = new ProbeEngine(() => {
		const index = processes++;
		let alive = true;
		return {
			get alive() {
				return alive;
			},
			request<T>(): Promise<T> {
				return index < 2 ? new Promise(() => {}) : Promise.resolve("ok" as T);
			},
			kill() {
				alive = false;
				killed++;
			},
		};
	}, 5);
	await expect(pool.request({})).rejects.toThrow("timed out");
	expect(killed).toBe(2);
	expect(await pool.request<string>({})).toBe("ok");
});

test("queued probes get their full timeout after the previous request settles", async () => {
	const first = Promise.withResolvers<string>();
	let calls = 0;
	const pool = new ProbeEngine(() => ({
		alive: true,
		request<T>(): Promise<T> {
			calls++;
			return (
				calls === 1 ? first.promise : Promise.resolve("second")
			) as Promise<T>;
		},
		kill() {},
	}));
	const one = pool.request({});
	const two = pool.request({});
	await Promise.resolve();
	expect(calls).toBe(1);
	first.resolve("first");
	expect(await one).toBe("first");
	expect(await two).toBe("second");
});
