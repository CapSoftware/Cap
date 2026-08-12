import { native } from "./bridge";
export const exit = (exitCode = 0) => native<void>("app.exit", { exitCode });
export const relaunch = () => native<void>("app.relaunch");
