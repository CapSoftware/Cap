// A promise rejected with no handler ends a Bun process, and with it every
// job the server is running. Media libraries can leave one behind after an
// error the caller already handled: mediabunny 1.45 `Input.dispose()` chains
// `.then()` on a demuxer promise that failed format detection, so one
// unreadable upload restarted the server. Log the rejection and keep serving.
export function installUnhandledRejectionGuard(): () => void {
	let count = 0;
	const onRejection = (reason: unknown) => {
		count += 1;
		const error = reason instanceof Error ? reason : null;
		console.error(
			JSON.stringify({
				event: "unhandled_rejection",
				timestamp: new Date().toISOString(),
				pid: process.pid,
				count,
				name: error?.name ?? typeof reason,
				message: (error?.message ?? String(reason)).slice(0, 500),
				stack: error?.stack?.split("\n").slice(0, 8).join("\n"),
			}),
		);
	};
	process.on("unhandledRejection", onRejection);
	return () => {
		process.off("unhandledRejection", onRejection);
	};
}
