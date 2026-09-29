import { createSignal } from "solid-js";

/// Whether the export in progress is rendering on Cap's servers. The web
/// editor sends an export there when this browser can't render or encode it.
const [serverExport, setServerExport] = createSignal(false);

export { serverExport, setServerExport };
