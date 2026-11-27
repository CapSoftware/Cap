import { emitEditorEvent, listenEditorEvent } from "./editor-api";

type CloseRequest = { preventDefault: () => void };
type CloseHandler = (event: CloseRequest) => void | Promise<void>;

const closeHandlers = new Set<CloseHandler>();
let closeInProgress = false;

export async function closeEditor() {
	if (closeInProgress || closeHandlers.size === 0) {
		await emitEditorEvent("editor-close-approved");
		return;
	}
	closeInProgress = true;
	let prevented = false;
	try {
		for (const handler of closeHandlers) {
			await handler({
				preventDefault: () => {
					prevented = true;
				},
			});
		}
		if (!prevented) await emitEditorEvent("editor-close-approved");
	} finally {
		closeInProgress = false;
	}
}

export function onEditorCloseRequested(handler: CloseHandler) {
	closeHandlers.add(handler);
	const unlisten = listenEditorEvent("editor-close-requested", () =>
		handler({
			preventDefault: () => {
				void emitEditorEvent("editor-close-prevented");
			},
		}),
	);
	return () => {
		closeHandlers.delete(handler);
		unlisten();
	};
}
