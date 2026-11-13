// A worker for the isolated worker pool tests. It answers with its own pid so
// a test can tell which process served a request.
process.on("message", (request: { id: number; op: string; ms?: number }) => {
	const reply = (body: object) => process.send?.({ id: request.id, ...body });
	if (request.op === "pid") reply({ ok: true, value: process.pid });
	else if (request.op === "fail")
		reply({ ok: false, error: { message: "refused", pid: process.pid } });
	else if (request.op === "crash") process.exit(70);
	else if (request.op === "die") process.kill(process.pid, "SIGKILL");
	else if (request.op === "spin") {
		const end = Date.now() + (request.ms ?? 60_000);
		while (Date.now() < end) {}
		reply({ ok: true, value: process.pid });
	} else if (request.op === "slow")
		setTimeout(
			() => reply({ ok: true, value: process.pid }),
			request.ms ?? 1_000,
		);
});
process.on("disconnect", () => process.exit(0));
process.send?.({ id: 0, ok: true, value: "ready" });
