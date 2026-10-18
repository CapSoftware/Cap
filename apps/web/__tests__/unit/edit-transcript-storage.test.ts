import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		NEXTAUTH_SECRET: "test-secret-with-enough-entropy",
	}),
}));

vi.mock("server-only", () => ({}));

describe("edit transcript storage", () => {
	it("encrypts and authenticates transcript objects for one video", async () => {
		const { decryptEditTranscriptObject, encryptEditTranscriptObject } =
			await import("@/lib/edit-transcript-storage");
		const plaintext = JSON.stringify({
			words: [{ text: "private deleted phrase" }],
		});

		const encrypted = encryptEditTranscriptObject(
			plaintext,
			"owner-1",
			"video-1",
		);

		expect(encrypted).not.toContain("private deleted phrase");
		expect(decryptEditTranscriptObject(encrypted, "owner-1", "video-1")).toBe(
			plaintext,
		);
		expect(
			decryptEditTranscriptObject(encrypted, "owner-1", "video-2"),
		).toBeNull();
	});

	it("rejects modified and plaintext objects", async () => {
		const { decryptEditTranscriptObject, encryptEditTranscriptObject } =
			await import("@/lib/edit-transcript-storage");
		const encrypted = encryptEditTranscriptObject(
			'{"words":[]}',
			"owner-1",
			"video-1",
		);
		const parts = encrypted.split(".");
		const ciphertext = parts[3] ?? "";
		parts[3] = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
		const tampered = parts.join(".");

		expect(
			decryptEditTranscriptObject(tampered, "owner-1", "video-1"),
		).toBeNull();
		expect(
			decryptEditTranscriptObject(
				'{"words":[{"text":"plaintext"}]}',
				"owner-1",
				"video-1",
			),
		).toBeNull();
	});
});
