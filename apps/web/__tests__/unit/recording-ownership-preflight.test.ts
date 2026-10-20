import {
	openPreflight,
	PREFLIGHT_POLICY,
	type PreflightDecode,
	preflightHash,
	preflightReceiptSchema,
	preflightRequestHash,
	preflightRequestSchema,
	sealPreflight,
} from "@cap/utils/recording-ownership-preflight";
import { describe, expect, it, vi } from "vitest";
import { prepareOwnershipPreflight } from "@/lib/recording-ownership-preflight";
import {
	inspectOwnershipHeads,
	ownershipPreflightBinding,
	planOwnershipTransfer,
	requireOwnershipPlanReady,
} from "@/lib/recording-ownership-transfer";
import {
	mediaFixture,
	ownershipFixture,
	sourcePrefix,
} from "../helpers/ownership-transfer";

const secret = "synthetic-preflight-authentication-fixture-only";
vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_WEBHOOK_SECRET:
			"synthetic-preflight-authentication-fixture-only",
	}),
}));
const decode: PreflightDecode = {
	fullDecode: true,
	video: { frameCount: 10, startTime: 0, endTime: 1, duration: 1 },
	audio: null,
	integrity: {
		video: {
			contentSha256: "a".repeat(64),
			timelineSha256: "b".repeat(64),
			format: "synthetic-video",
		},
		audio: null,
	},
};
async function fixture() {
	const snapshot = ownershipFixture();
	snapshot.video.source = { type: "webMP4" };
	snapshot.video.metadata = {};
	snapshot.upload = null;
	snapshot.processing = null;
	snapshot.edit = null;
	snapshot.comments = [];
	const { objects, store } = mediaFixture();
	objects.clear();
	objects.set(`${sourcePrefix}result.mp4`, {
		bytes: "synthetic-result",
		identity: '"synthetic-etag"',
	});
	store.head = vi.fn(async (key) => {
		const { sha256: _sha256, ...head } = await store.inspect(key);
		return { ...head, versionId: head.versionId ?? null };
	});
	store.signRead = vi.fn(
		async (key, versionId) =>
			`https://storage.example.test/${key}${versionId ? "?versionId=synthetic-version" : ""}`,
	);
	const manifest = await inspectOwnershipHeads(store, sourcePrefix);
	const binding = ownershipPreflightBinding(
		snapshot,
		"test-target",
		null,
		manifest,
	);
	const receipt = {
		policy: PREFLIGHT_POLICY,
		context: binding.context,
		manifestHash: preflightHash(manifest),
		requestHash: preflightRequestHash(binding),
		issuedAt: Date.now(),
		expiresAt: Date.now() + 3600000,
		objects: await Promise.all(
			manifest.map(async (object) => ({
				ref: preflightHash(object.key),
				sha256: (await store.inspect(object.key)).sha256,
			})),
		),
		assets: binding.assets.map((asset) => ({
			ref: asset.ref,
			decode: structuredClone(decode),
		})),
	};
	const plan = () =>
		planOwnershipTransfer(snapshot, "test-target", null, store, {
			token: sealPreflight("receipt", receipt, secret),
			secret,
		});
	return { snapshot, objects, store, receipt, binding, plan };
}
describe("trusted ownership preflight acceptance", () => {
	it("prepares an authorized read challenge without media writes or secret disclosure", async () => {
		const f = await fixture();
		const result = await prepareOwnershipPreflight(
			f.snapshot,
			"test-target",
			null,
			f.store,
		);
		const request = openPreflight(
			"request",
			result.request,
			secret,
			preflightRequestSchema,
		);
		expect(request.assets).toHaveLength(1);
		expect(request.context).toBe(f.binding.context);
		expect(JSON.stringify(request)).not.toContain(secret);
		expect(f.store.copyIfAbsent).not.toHaveBeenCalled();
		expect(() =>
			openPreflight("receipt", result.request, secret, preflightReceiptSchema),
		).toThrow("INVALID_EVIDENCE");
	});
	it("accepts a trusted standalone receipt without manufacturing upload state or legacy evidence", async () => {
		const f = await fixture();
		const plan = await f.plan();
		expect(plan.completion).toBe("preflight");
		expect(f.snapshot.upload).toBeNull();
		expect(f.snapshot.video.metadata).toEqual({});
		expect(requireOwnershipPlanReady(f.snapshot, plan, secret)).toBe(
			"preflight",
		);
		expect(f.store.copyIfAbsent).not.toHaveBeenCalled();
	});
	it.each([
		"signature",
		"request-domain",
		"unsigned-claims",
		"expiry",
		"recording",
		"destination",
		"snapshot",
		"manifest",
		"object",
		"asset",
		"selected",
		"forged-decode",
	])("rejects invalid evidence binding: %s", async (mode) => {
		const f = await fixture();
		if (mode === "expiry") f.receipt.expiresAt = Date.now() - 1;
		if (mode === "recording" || mode === "destination")
			f.receipt.context = preflightHash(mode);
		if (mode === "snapshot") f.snapshot.video.duration = 2;
		if (mode === "manifest")
			f.objects.set(`${sourcePrefix}extra.bin`, {
				bytes: "synthetic-extra",
				identity: '"extra"',
			});
		if (mode === "object") f.receipt.objects = [];
		if (mode === "asset") f.receipt.assets = [];
		if (mode === "selected")
			f.receipt.requestHash = preflightHash("other-output");
		if (mode === "forged-decode") {
			const asset = f.receipt.assets[0];
			if (!asset) throw new Error("Missing synthetic asset");
			asset.decode.fullDecode = false as true;
		}
		let token = sealPreflight(
			mode === "request-domain" ? "request" : "receipt",
			f.receipt,
			secret,
		);
		if (mode === "signature") token += "0";
		if (mode === "unsigned-claims") token = JSON.stringify(f.receipt);
		await expect(
			planOwnershipTransfer(f.snapshot, "test-target", null, f.store, {
				token,
				secret,
			}),
		).rejects.toThrow();
		expect(f.store.copyIfAbsent).not.toHaveBeenCalled();
	});
	it("rechecks expiry and snapshot under the publication lock", async () => {
		const f = await fixture();
		const plan = await f.plan();
		f.snapshot.video.duration = 3;
		expect(() => requireOwnershipPlanReady(f.snapshot, plan, secret)).toThrow();
		f.snapshot.video.duration = 1;
		f.receipt.expiresAt = Date.now() - 1;
		plan.preflight = sealPreflight("receipt", f.receipt, secret);
		expect(() => requireOwnershipPlanReady(f.snapshot, plan, secret)).toThrow(
			"EXPIRED",
		);
	});
	it.each(["processing", "transcription", "upload"])(
		"keeps incomplete %s held despite a valid receipt",
		async (mode) => {
			const f = await fixture();
			if (mode === "processing")
				f.snapshot.processing = ownershipFixture().processing;
			if (mode === "processing" && f.snapshot.processing)
				f.snapshot.processing.state = "processing";
			if (mode === "transcription")
				f.snapshot.video.transcriptionStatus = "PROCESSING";
			if (mode === "upload") {
				f.snapshot.upload = ownershipFixture().upload;
				if (f.snapshot.upload) f.snapshot.upload.phase = "uploading";
			}
			await expect(f.plan()).rejects.toThrow();
		},
	);
	it("does not accept a caller's decode claims without the trusted receipt MAC", async () => {
		const f = await fixture();
		const token = sealPreflight(
			"receipt",
			f.receipt,
			"synthetic-untrusted-caller-authentication",
		);
		await expect(
			planOwnershipTransfer(f.snapshot, "test-target", null, f.store, {
				token,
				secret,
			}),
		).rejects.toThrow("INVALID_EVIDENCE");
	});
});
