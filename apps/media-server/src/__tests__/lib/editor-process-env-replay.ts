import assert from "node:assert/strict";
import { editorProcessEnv, runEditorFile } from "../../lib/editor-process";

const previousWebhook = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
const previousAws = process.env.AWS_SECRET_ACCESS_KEY;
process.env.MEDIA_SERVER_WEBHOOK_SECRET = "webhook-secret-sentinel";
process.env.AWS_SECRET_ACCESS_KEY = "aws-secret-sentinel";
try {
	const env = editorProcessEnv("internal-token-sentinel");
	assert.equal(env.CAP_WEB_EDITOR_INTERNAL_TOKEN, "internal-token-sentinel");
	assert.equal(env.MEDIA_SERVER_WEBHOOK_SECRET, undefined);
	assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
	const { stdout } = await runEditorFile("env", [], {
		env: { MEDIA_SERVER_WEBHOOK_SECRET: "overridden-sentinel" },
	});
	assert.equal(stdout.includes("MEDIA_SERVER_WEBHOOK_SECRET="), false);
	assert.equal(stdout.includes("AWS_SECRET_ACCESS_KEY="), false);
	console.log(JSON.stringify({ subprocessCredentials: "excluded" }));
} finally {
	if (previousWebhook === undefined) {
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	} else {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousWebhook;
	}
	if (previousAws === undefined) {
		delete process.env.AWS_SECRET_ACCESS_KEY;
	} else {
		process.env.AWS_SECRET_ACCESS_KEY = previousAws;
	}
}
