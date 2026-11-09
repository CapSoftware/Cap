import { autoInit, init } from "./index";

const script = document.currentScript as HTMLScriptElement | null;
autoInit(script);

export { init };
