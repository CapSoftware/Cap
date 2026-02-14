export type SabWriteFailureDecision =
	| { action: "retry"; nextRetryCount: number }
	| { action: "fallback_oversize"; nextRetryCount: number }
	| { action: "fallback_retry_limit"; nextRetryCount: number };

export function decideSabWriteFailure(
	isOversized: boolean,
	currentRetryCount: number,
	retryLimit: number,
): SabWriteFailureDecision {
	if (isOversized) {
		return { action: "fallback_oversize", nextRetryCount: 0 };
	}

	if (currentRetryCount >= retryLimit) {
		return { action: "fallback_retry_limit", nextRetryCount: 0 };
	}

	return { action: "retry", nextRetryCount: currentRetryCount + 1 };
}
