import { onCleanup } from "solid-js";

type EditorEventSource<T> = {
	listen: (cb: (event: { payload: T }) => void) => Promise<() => void>;
};

export function createEditorEventListener<T>(
	source: EditorEventSource<T>,
	callback: (payload: T) => void,
): void {
	let aborted = false;
	const unlisten = source.listen((event) => {
		if (aborted) return;
		callback(event.payload);
	});

	onCleanup(() => {
		aborted = true;
		unlisten.then((cleanup) => cleanup());
	});
}
