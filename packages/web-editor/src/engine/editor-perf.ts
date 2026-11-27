type EditorPerf = {
	marks: Record<string, number>;
	events: [number, string][];
	spans: Record<string, number[]>;
	counts: Record<string, number>;
	reset: () => void;
};

const MAX_SAMPLES = 4000;

function perfEnabled() {
	try {
		return (
			localStorage.getItem("cap-editor-perf") === "1" ||
			new URLSearchParams(location.search).has("perf")
		);
	} catch {
		return false;
	}
}

const perf: EditorPerf | null = perfEnabled()
	? {
			marks: {},
			events: [],
			spans: {},
			counts: {},
			reset() {
				this.spans = {};
				this.counts = {};
			},
		}
	: null;

if (perf) (window as { __capEditorPerf?: EditorPerf }).__capEditorPerf = perf;

export function perfMark(name: string) {
	if (!perf || name in perf.marks) return;
	perf.marks[name] = performance.now();
	performance.mark(`cap-editor:${name}`);
}

export function perfStart() {
	return perf ? performance.now() : 0;
}

export function perfSpan(name: string, start: number) {
	if (!perf) return;
	const samples = perf.spans[name] ?? [];
	perf.spans[name] = samples;
	if (samples.length >= MAX_SAMPLES) samples.shift();
	samples.push(performance.now() - start);
}

export function perfEvent(name: string) {
	if (!perf) return;
	if (perf.events.length >= MAX_SAMPLES) perf.events.shift();
	perf.events.push([performance.now(), name]);
}

export function perfCount(name: string) {
	if (!perf) return;
	perf.counts[name] = (perf.counts[name] ?? 0) + 1;
}
