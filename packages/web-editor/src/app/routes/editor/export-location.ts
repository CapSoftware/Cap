import { createSignal } from "solid-js";

const [serverExport, setServerExport] = createSignal(false);

export { serverExport, setServerExport };
