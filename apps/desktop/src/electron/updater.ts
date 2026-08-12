export interface CheckOptions { headers?: Record<string, string>; timeout?: number; target?: string; }
export interface DownloadEvent { event: "Started" | "Progress" | "Finished"; data?: { contentLength?: number; chunkLength?: number }; }
export interface Update {
	version: string;
	currentVersion: string;
	date?: string;
	body?: string;
	rawJson: Record<string, unknown>;
	download(listener?: (event: DownloadEvent) => void): Promise<void>;
	install(): Promise<void>;
	downloadAndInstall(listener?: (event: DownloadEvent) => void): Promise<void>;
	close(): Promise<void>;
}
export async function check(_options?: CheckOptions): Promise<Update | null> { return null; }
