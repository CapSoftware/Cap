import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "../src/config";
import { createRedactor, redactValue, withoutQuery } from "../src/redact";
import { SERVER_VERSION } from "../src/version";

const KEY = "csk_0123456789abcdefghjkmnpqrstvwx";

const refusal = (env: Record<string, string | undefined>) => {
	try {
		readConfig(env);
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		return (error as Error).message;
	}
	throw new Error("The configuration was accepted");
};

describe("configuration", () => {
	it("defaults to the hosted API and console", () => {
		expect(readConfig({ CAP_SECRET_KEY: ` ${KEY}\n` })).toEqual({
			secretKey: KEY,
			apiUrl: "https://cap.so",
			consoleUrl: "https://cap.so/dashboard/infra",
		});
	});

	it("accepts another API address and trims its trailing slash", () => {
		const config = readConfig({
			CAP_SECRET_KEY: KEY,
			CAP_API_URL: "http://127.0.0.1:4010/",
		});
		expect(config.apiUrl).toBe("http://127.0.0.1:4010");
		expect(config.consoleUrl).toBe("http://127.0.0.1:4010/dashboard/infra");
	});

	it("says when the key is missing", () => {
		expect(refusal({})).toMatch(/CAP_SECRET_KEY is not set/);
		expect(refusal({ CAP_SECRET_KEY: "   " })).toMatch(/is not set/);
	});

	it.each([
		["cpk_0123456789abcdefghjkmnpqrstvwx", /public key/],
		["cut_eyJ2IjoxfQ.c2lnbmF0dXJl", /upload token/],
		["csk_short", /not a Cap Infra secret key/],
		["csk_with spaces inside", /not a Cap Infra secret key/],
		['"csk_0123456789abcdefghjkmnpq"', /not a Cap Infra secret key/],
		["sk_live_0123456789abcdef", /not a Cap Infra secret key/],
	])("refuses a malformed key without echoing it", (value, reason) => {
		const message = refusal({ CAP_SECRET_KEY: value });
		expect(message).toMatch(reason);
		expect(message).not.toContain(value);
		expect(message).not.toContain(value.slice(4));
		expect(message).toContain("https://cap.so/dashboard/infra");
	});

	it.each([
		["not a url", /not a URL/],
		["http://example.com", /must use https/],
		["ftp://cap.so", /must use https/],
		["https://user:pass@cap.so", /no credentials/],
		["https://cap.so/?x=1", /no credentials, query or fragment/],
	])("refuses the API address %s", (value, reason) => {
		expect(refusal({ CAP_SECRET_KEY: KEY, CAP_API_URL: value })).toMatch(
			reason,
		);
	});

	it("reports the version the package declares", () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		);
		expect(SERVER_VERSION).toBe(manifest.version);
	});
});

describe("redaction", () => {
	const redact = createRedactor(KEY);

	it("removes the configured key, any other key and any upload token", () => {
		const text = redact(
			`key ${KEY} other csk_zzzzzzzzzzzzzzzz token cut_eyJ2IjoxLCJhcHAiOiJhIn0.Jm2cQ9s2Lm8Rt1Xy done`,
		);
		expect(text).toBe(
			"key csk_[redacted] other csk_[redacted] token cut_[redacted] done",
		);
	});

	it("removes the credentials of a storage link", () => {
		expect(
			redact(
				"https://bucket.example.com/key?X-Amz-Credential=AKIA%2Fus&X-Amz-Signature=0a1b2c&partNumber=3",
			),
		).toBe(
			"https://bucket.example.com/key?X-Amz-Credential=[redacted]&X-Amz-Signature=[redacted]&partNumber=3",
		);
	});

	it("keeps a result valid JSON when a value holds a quote after a credential", () => {
		const body = {
			metadata: {
				note: 'https://example.com/?X-Amz-Signature=abc"rest',
				path: "C:\\clips\\a.mp4",
				nested: [`token cut_eyJ2IjoxLCJhcHAiOiJhIn0.Jm2cQ9s2Lm8Rt1Xy "quoted"`],
			},
			[`key ${KEY}`]: KEY,
			count: 3,
			missing: null,
		};

		const text = JSON.stringify(redactValue(redact, body));

		expect(JSON.parse(text)).toEqual({
			metadata: {
				note: 'https://example.com/?X-Amz-Signature=[redacted]"rest',
				path: "C:\\clips\\a.mp4",
				nested: ['token cut_[redacted] "quoted"'],
			},
			"key csk_[redacted]": "csk_[redacted]",
			count: 3,
			missing: null,
		});
		expect(text).not.toContain(KEY);
	});

	it("keeps the documentation placeholder readable", () => {
		expect(redact("Send Authorization: Bearer csk_... with a key")).toBe(
			"Send Authorization: Bearer csk_... with a key",
		);
	});

	it("drops the query string and fragment of a link", () => {
		expect(
			withoutQuery("https://files.example.com/a.mp3?X-Amz-Signature=abc#t"),
		).toBe("https://files.example.com/a.mp3");
		expect(withoutQuery("https://files.example.com/a.mp3")).toBe(
			"https://files.example.com/a.mp3",
		);
		expect(withoutQuery(null)).toBeNull();
	});
});
