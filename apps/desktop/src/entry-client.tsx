// @refresh reload
import { mount, StartClient } from "@solidjs/start/client";
import { type } from "@tauri-apps/plugin-os";

document.documentElement.classList.add(`platform-${type()}`);
mount(() => <StartClient />, document.getElementById("app")!);
