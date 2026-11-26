// FFmpeg, ffprobe and the probe workers run as the same user as the server,
// and read files nobody vouches for. A process the kernel marks as not
// dumpable keeps its /proc entries (environ, mem, maps) and ptrace from
// other processes of that user, so a decoder taken over by a hostile file
// cannot read the secrets in the server's environment. Children start
// dumpable again when they exec, so this reaches only the server.

const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;

type Prctl = (option: number, arg: number) => number;

function loadPrctl(): Prctl | null {
	if (process.platform !== "linux") return null;
	try {
		const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
		for (const name of ["libc.so.6", "libc.so"]) {
			try {
				const { symbols } = dlopen(name, {
					prctl: {
						args: [
							FFIType.i32,
							FFIType.u64,
							FFIType.u64,
							FFIType.u64,
							FFIType.u64,
						],
						returns: FFIType.i32,
					},
				});
				return (option, arg) => symbols.prctl(option, arg, 0, 0, 0) as number;
			} catch {}
		}
	} catch {}
	return null;
}

// Whether the server is now hidden from its own children. False where the
// platform has no such switch.
export function hideServerFromChildren(): boolean {
	const prctl = loadPrctl();
	if (!prctl) return false;
	if (prctl(PR_SET_DUMPABLE, 0) !== 0) {
		console.warn("[media-server] Could not mark the server as not dumpable");
		return false;
	}
	return prctl(PR_GET_DUMPABLE, 0) === 0;
}
