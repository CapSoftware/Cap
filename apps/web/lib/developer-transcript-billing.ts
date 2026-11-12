import { db } from "@cap/database";
import {
	developerCreditAccounts,
	developerTranscripts,
} from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { debitDeveloperUsage } from "@/lib/developer-credits";
import {
	transcriptionBilledSeconds,
	transcriptionMicroCredits,
} from "@/lib/developer-pricing";
import { TRANSCRIPT_FULL_HOLD_MICRO_CREDITS } from "@/lib/developer-transcript-hold";
import {
	TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS,
	type TranscriptErrorCode,
} from "@/lib/developer-transcripts";
import {
	availableBalance,
	heldTranscriptMicroCredits,
} from "@/lib/infra-balance";
import { accountStanding } from "@/lib/infra-standing";

export const INSUFFICIENT_CREDITS_MESSAGE =
	"The credit balance could not cover this transcript. Nothing was charged.";

export type TranscriptReservation =
	| { state: "reserved"; reservedMicroCredits: number }
	| { state: "insufficient_credits" }
	| { state: "skipped" };

export type TranscriptHold =
	| { state: "held"; reservedMicroCredits: number }
	| {
			state: "contended" | "insufficient";
			neededMicroCredits: number;
			availableMicroCredits: number;
	  }
	| { state: "skipped" };

export type TranscriptSettlement =
	| { state: "complete"; chargedMicroCredits: number; alreadySettled: boolean }
	| { state: "insufficient_credits" }
	| { state: "skipped"; reason: "missing" | "deleted" | "not_processing" };

export type TranscriptStartRefusal = {
	code: "out_of_credit" | "insufficient_credits";
	message: string;
	shortfallMicroCredits: number;
};

export function getAvailableTranscriptBalance(appId: string) {
	return availableBalance(appId);
}

const dollarsUp = (microCredits: number) =>
	`$${(Math.ceil(Math.max(0, microCredits) / 1000) / 100).toFixed(2)}`;

export async function transcriptStartRefusal(
	appId: string,
	now: Date = new Date(),
): Promise<TranscriptStartRefusal | null> {
	const [account] = await db()
		.select({ id: developerCreditAccounts.id })
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.appId, appId))
		.limit(1);
	const available = account ? await availableBalance(appId) : null;
	if (!account || available === null) {
		return {
			code: "insufficient_credits",
			message: "This app has no credit. Add credits to start a transcript.",
			shortfallMicroCredits: TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS,
		};
	}

	const { standing, lastCharge } = await accountStanding(
		db(),
		{ id: account.id, balanceMicroCredits: available },
		now,
	);
	if (standing.state !== "active") {
		const shortfallMicroCredits =
			Math.max(
				lastCharge?.owedMicroCredits ?? 0,
				TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS,
			) - available;
		return {
			code: "out_of_credit",
			message: `This app is out of credit, so new transcripts are blocked. Add at least ${dollarsUp(shortfallMicroCredits)} to start transcripts again.`,
			shortfallMicroCredits,
		};
	}

	if (available < TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS) {
		const shortfallMicroCredits =
			TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS - available;
		return {
			code: "insufficient_credits",
			message: `Starting a transcript needs ${dollarsUp(TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS)} of available credit. Add at least ${dollarsUp(shortfallMicroCredits)}.`,
			shortfallMicroCredits,
		};
	}
	return null;
}

export async function hasMinimumTranscriptBalance(appId: string) {
	return (await transcriptStartRefusal(appId)) === null;
}

async function findTranscriptApp(transcriptId: string) {
	const [transcript] = await db()
		.select({ appId: developerTranscripts.appId })
		.from(developerTranscripts)
		.where(eq(developerTranscripts.id, transcriptId))
		.limit(1);
	return transcript?.appId ?? null;
}

export async function holdTranscriptCredits(input: {
	transcriptId: string;
	microCredits: number;
	releaseWhileWaiting?: boolean;
}): Promise<TranscriptHold> {
	const appId = await findTranscriptApp(input.transcriptId);
	if (!appId) return { state: "skipped" };
	const needed = Math.max(0, Math.ceil(input.microCredits));

	return db().transaction(async (tx) => {
		const [account] = await tx
			.select({
				balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
			})
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.appId, appId))
			.limit(1)
			.for("update");

		const [transcript] = await tx
			.select({
				status: developerTranscripts.status,
				deletedAt: developerTranscripts.deletedAt,
				reservedMicroCredits: developerTranscripts.reservedMicroCredits,
			})
			.from(developerTranscripts)
			.where(eq(developerTranscripts.id, input.transcriptId))
			.limit(1)
			.for("update");
		if (
			!transcript ||
			transcript.deletedAt ||
			transcript.status !== "processing"
		) {
			return { state: "skipped" };
		}

		const current = Number(transcript.reservedMicroCredits) || 0;
		if (current >= needed) {
			return { state: "held", reservedMicroCredits: current };
		}

		const heldByOthers = await heldTranscriptMicroCredits(
			tx,
			appId,
			input.transcriptId,
		);
		const available = (account?.balanceMicroCredits ?? 0) - heldByOthers;
		if (!account || available < needed) {
			const contended = Boolean(account) && heldByOthers > 0;
			if (contended && input.releaseWhileWaiting && current > 0) {
				await tx
					.update(developerTranscripts)
					.set({ reservedMicroCredits: 0 })
					.where(eq(developerTranscripts.id, input.transcriptId));
			}
			return {
				state: contended ? "contended" : "insufficient",
				neededMicroCredits: needed,
				availableMicroCredits: Math.max(0, available),
			};
		}

		await tx
			.update(developerTranscripts)
			.set({ reservedMicroCredits: needed })
			.where(eq(developerTranscripts.id, input.transcriptId));

		return { state: "held", reservedMicroCredits: needed };
	});
}

export async function reserveTranscriptCredits(input: {
	transcriptId: string;
	durationSeconds: number;
}): Promise<TranscriptReservation> {
	const appId = await findTranscriptApp(input.transcriptId);
	if (!appId) return { state: "skipped" };
	const cost = Math.min(
		transcriptionMicroCredits(input.durationSeconds),
		TRANSCRIPT_FULL_HOLD_MICRO_CREDITS,
	);

	return db().transaction(async (tx) => {
		const [account] = await tx
			.select({
				balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
			})
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.appId, appId))
			.limit(1)
			.for("update");
		if (!account) return { state: "insufficient_credits" };

		const [transcript] = await tx
			.select({
				status: developerTranscripts.status,
				deletedAt: developerTranscripts.deletedAt,
			})
			.from(developerTranscripts)
			.where(eq(developerTranscripts.id, input.transcriptId))
			.limit(1)
			.for("update");
		if (
			!transcript ||
			transcript.deletedAt ||
			transcript.status !== "processing"
		) {
			return { state: "skipped" };
		}

		const held = await heldTranscriptMicroCredits(
			tx,
			appId,
			input.transcriptId,
		);
		if (account.balanceMicroCredits - held < cost) {
			return { state: "insufficient_credits" };
		}

		await tx
			.update(developerTranscripts)
			.set({
				reservedMicroCredits: cost,
				durationSeconds: input.durationSeconds,
			})
			.where(eq(developerTranscripts.id, input.transcriptId));

		return { state: "reserved", reservedMicroCredits: cost };
	});
}

export async function settleTranscript(input: {
	transcriptId: string;
	durationSeconds: number;
	language: string | null;
	text: string;
	wordCount: number;
	resultKey: string;
}): Promise<TranscriptSettlement> {
	const appId = await findTranscriptApp(input.transcriptId);
	if (!appId) return { state: "skipped", reason: "missing" };
	const cost = transcriptionMicroCredits(input.durationSeconds);

	return db().transaction(async (tx) => {
		await tx
			.select({ id: developerCreditAccounts.id })
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.appId, appId))
			.limit(1)
			.for("update");

		const [transcript] = await tx
			.select({
				id: developerTranscripts.id,
				status: developerTranscripts.status,
				deletedAt: developerTranscripts.deletedAt,
				reservedMicroCredits: developerTranscripts.reservedMicroCredits,
			})
			.from(developerTranscripts)
			.where(eq(developerTranscripts.id, input.transcriptId))
			.limit(1)
			.for("update");

		if (!transcript) return { state: "skipped", reason: "missing" };
		if (transcript.deletedAt) return { state: "skipped", reason: "deleted" };
		if (transcript.status === "complete") {
			return {
				state: "complete",
				chargedMicroCredits: 0,
				alreadySettled: true,
			};
		}
		if (transcript.status !== "processing") {
			return { state: "skipped", reason: "not_processing" };
		}

		const held = Number(transcript.reservedMicroCredits) || 0;
		const charge = held > 0 ? Math.min(cost, held) : cost;

		const debit =
			charge > 0
				? await debitDeveloperUsage(tx, {
						appId,
						microCredits: charge,
						type: "transcription",
						referenceId: transcript.id,
						referenceType: "developer_transcript",
						settlesTranscriptId: transcript.id,
						metadata: {
							durationSeconds: input.durationSeconds,
							billedSeconds: transcriptionBilledSeconds(input.durationSeconds),
						},
					})
				: ({ state: "already_paid" } as const);

		if (debit.state === "no_account" || debit.state === "insufficient") {
			await tx
				.update(developerTranscripts)
				.set({
					status: "error",
					errorCode: "insufficient_credits" satisfies TranscriptErrorCode,
					errorMessage: INSUFFICIENT_CREDITS_MESSAGE,
					durationSeconds: input.durationSeconds,
					reservedMicroCredits: 0,
					text: null,
					resultKey: null,
					completedAt: new Date(),
				})
				.where(eq(developerTranscripts.id, transcript.id));
			return { state: "insufficient_credits" };
		}

		await tx
			.update(developerTranscripts)
			.set({
				status: "complete",
				durationSeconds: input.durationSeconds,
				language: input.language,
				text: input.text,
				wordCount: input.wordCount,
				resultKey: input.resultKey,
				reservedMicroCredits: 0,
				billedMicroCredits: charge,
				errorCode: null,
				errorMessage: null,
				completedAt: new Date(),
			})
			.where(eq(developerTranscripts.id, transcript.id));

		return {
			state: "complete",
			chargedMicroCredits:
				debit.state === "debited" ? debit.chargedMicroCredits : 0,
			alreadySettled: false,
		};
	});
}
