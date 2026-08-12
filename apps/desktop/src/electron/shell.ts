import { native } from "./bridge";

export const open = (path: string, _openWith?: string) => native<void>("shell.open", { path });

export class Command {
	constructor(public program: string, public args: string[] = [], public options: Record<string, unknown> = {}) {}
	static create(program: string, args: string[] = [], options: Record<string, unknown> = {}) { return new Command(program, args, options); }
	static sidecar(program: string, args: string[] = [], options: Record<string, unknown> = {}) { return new Command(program, args, options); }
	execute() { return native<CommandOutput>("shell.execute", { program: this.program, args: this.args, options: this.options }); }
	spawn() { return native<Child>("shell.spawn", { program: this.program, args: this.args, options: this.options }); }
}

export interface CommandOutput { code: number; signal: number | null; stdout: string; stderr: string; }
export interface Child { pid: number; kill(): Promise<void>; write(data: string | Uint8Array): Promise<void>; }
