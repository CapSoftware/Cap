import { open } from "node:fs/promises";
import { OwnershipPreflightError } from "@cap/utils/recording-ownership-preflight";
import { decodeOwnershipPreflightFile } from "../apps/media-server/src/lib/ownership-preflight-decoder";
import {
	cleanupOwnershipPreflightScratch,
	readOwnershipPreflightRequest,
	runOwnershipPreflight,
} from "./lib/recording-ownership-preflight";

const [requestPath, directory, receiptPath, cleanup, extra] =
	process.argv.slice(2);
const secret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
const allowedOrigins =
	process.env.OWNERSHIP_PREFLIGHT_STORAGE_ORIGINS?.split(",").filter(Boolean);
delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
if (
	!requestPath ||
	!directory ||
	!receiptPath ||
	extra ||
	(cleanup !== undefined && cleanup !== "--cleanup") ||
	!allowedOrigins?.length ||
	!secret ||
	secret.length < 32 ||
	process.platform !== "linux"
) {
	console.error(
		"Usage: bun scripts/recording-ownership-preflight.ts REQUEST WORK_DIRECTORY RECEIPT [--cleanup]; trusted internal authentication and Linux are required",
	);
	process.exitCode = 1;
} else {
	const controller = new AbortController();
	const signals: NodeJS.EventEmitter = process;
	const cancel = () => controller.abort();
	signals.once("SIGTERM", cancel);
	signals.once("SIGINT", cancel);
	try {
		const requestToken = await readOwnershipPreflightRequest(requestPath);
		const receipt = await runOwnershipPreflight({
			requestToken,
			secret,
			allowedOrigins,
			directory,
			decode: decodeOwnershipPreflightFile,
			signal: controller.signal,
		});
		const output = await open(receiptPath, "wx", 0o600);
		try {
			await output.writeFile(receipt);
			await output.sync();
		} finally {
			await output.close();
		}
		console.info("Ownership preflight complete; receipt written");
		if (cleanup)
			await cleanupOwnershipPreflightScratch(requestToken, secret, directory);
	} catch (error) {
		console.error(
			`Ownership preflight held: ${error instanceof OwnershipPreflightError ? error.code : "UNAVAILABLE"}`,
		);
		process.exitCode = 1;
	} finally {
		signals.removeListener("SIGTERM", cancel);
		signals.removeListener("SIGINT", cancel);
	}
}
