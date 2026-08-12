import { native } from "./bridge";

export type OsType = "linux" | "macos" | "ios" | "android" | "windows";
export type Arch = "x86" | "x86_64" | "arm" | "aarch64" | "mips" | "mips64" | "powerpc" | "powerpc64" | "riscv64" | "s390x" | "sparc64";
import { bridge } from "./bridge";
export const arch = () => bridge().os.arch as Arch;
export const exeExtension = () => type() === "windows" ? ".exe" : "";
export const family = () => type() === "windows" ? "windows" : "unix";
export const hostname = () => native<string>("os.hostname");
export const locale = () => native<string | null>("os.locale");
export const platform = () => bridge().os.platform;
export const type = () => bridge().os.type as OsType;
export const version = () => bridge().os.version;
export const eol = () => "\n";
