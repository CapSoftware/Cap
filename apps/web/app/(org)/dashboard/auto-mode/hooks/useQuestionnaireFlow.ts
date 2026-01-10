"use client";

import type { AutoMode } from "@cap/web-domain";
import { useCallback, useEffect, useMemo, useState } from "react";

export type QuestionnaireStep =
	| "url"
	| "focus"
	| "actions"
	| "tone"
	| "duration"
	| "context";

export interface QuestionnaireAnswers {
	targetUrl: string;
	recordingFocus: AutoMode.AutoModeRecordingFocus | null;
	keyActions: string;
	narrationTone: AutoMode.AutoModeNarrationTone | null;
	durationPreference: AutoMode.AutoModeDurationPreference | null;
	additionalContext: string;
}

export interface StepConfig {
	id: QuestionnaireStep;
	label: string;
	required: boolean;
	skippable: boolean;
}

const STEP_ORDER = [
	"url",
	"focus",
	"actions",
	"tone",
	"duration",
	"context",
] as const satisfies readonly QuestionnaireStep[];

const STEP_CONFIGS: Record<QuestionnaireStep, StepConfig> = {
	url: { id: "url", label: "Target URL", required: false, skippable: true },
	focus: {
		id: "focus",
		label: "Recording Focus",
		required: true,
		skippable: false,
	},
	actions: {
		id: "actions",
		label: "Key Actions",
		required: true,
		skippable: false,
	},
	tone: {
		id: "tone",
		label: "Narration Tone",
		required: true,
		skippable: false,
	},
	duration: {
		id: "duration",
		label: "Duration",
		required: true,
		skippable: false,
	},
	context: {
		id: "context",
		label: "Additional Context",
		required: false,
		skippable: true,
	},
};

const INITIAL_ANSWERS: QuestionnaireAnswers = {
	targetUrl: "",
	recordingFocus: null,
	keyActions: "",
	narrationTone: null,
	durationPreference: null,
	additionalContext: "",
};

const STORAGE_KEY = "cap-auto-mode-questionnaire";

interface StoredState {
	answers: QuestionnaireAnswers;
	currentStep: QuestionnaireStep;
	initialPrompt: string;
}

function loadFromStorage(initialPrompt: string): StoredState | null {
	if (typeof window === "undefined") return null;

	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) return null;

		const parsed = JSON.parse(stored) as StoredState;
		if (parsed.initialPrompt !== initialPrompt) return null;

		return parsed;
	} catch {
		return null;
	}
}

function saveToStorage(state: StoredState): void {
	if (typeof window === "undefined") return;

	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// localStorage might be full or disabled
	}
}

function clearStorage(): void {
	if (typeof window === "undefined") return;

	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Ignore errors
	}
}

export interface UseQuestionnaireFlowOptions {
	initialPrompt: string;
	onComplete?: (answers: QuestionnaireAnswers) => void;
}

export interface UseQuestionnaireFlowReturn {
	currentStep: QuestionnaireStep;
	currentStepIndex: number;
	totalSteps: number;
	stepConfig: StepConfig;
	answers: QuestionnaireAnswers;
	isFirstStep: boolean;
	isLastStep: boolean;
	canGoNext: boolean;
	hasUrl: boolean;
	isComplete: boolean;

	goNext: () => void;
	goBack: () => void;
	skip: () => void;
	goToStep: (step: QuestionnaireStep) => void;
	setAnswer: <K extends keyof QuestionnaireAnswers>(
		field: K,
		value: QuestionnaireAnswers[K],
	) => void;
	reset: () => void;
}

function validateStep(
	step: QuestionnaireStep,
	answers: QuestionnaireAnswers,
): boolean {
	switch (step) {
		case "url":
			return true;
		case "focus":
			return answers.recordingFocus !== null;
		case "actions":
			return answers.keyActions.trim().length > 0;
		case "tone":
			return answers.narrationTone !== null;
		case "duration":
			return answers.durationPreference !== null;
		case "context":
			return true;
		default:
			return false;
	}
}

export function useQuestionnaireFlow({
	initialPrompt,
	onComplete,
}: UseQuestionnaireFlowOptions): UseQuestionnaireFlowReturn {
	const [currentStep, setCurrentStep] = useState<QuestionnaireStep>("url");
	const [answers, setAnswers] = useState<QuestionnaireAnswers>(INITIAL_ANSWERS);
	const [isComplete, setIsComplete] = useState(false);
	const [hasHydrated, setHasHydrated] = useState(false);

	useEffect(() => {
		const stored = loadFromStorage(initialPrompt);
		if (stored) {
			setAnswers(stored.answers);
			setCurrentStep(stored.currentStep);
		}
		setHasHydrated(true);
	}, [initialPrompt]);

	useEffect(() => {
		if (!hasHydrated) return;

		saveToStorage({
			answers,
			currentStep,
			initialPrompt,
		});
	}, [answers, currentStep, initialPrompt, hasHydrated]);

	const currentStepIndex = STEP_ORDER.indexOf(currentStep);
	const totalSteps = STEP_ORDER.length;
	const stepConfig = STEP_CONFIGS[currentStep];
	const isFirstStep = currentStepIndex === 0;
	const isLastStep = currentStepIndex === totalSteps - 1;
	const canGoNext = validateStep(currentStep, answers);
	const hasUrl = answers.targetUrl.trim().length > 0;

	const goNext = useCallback(() => {
		if (!canGoNext || isComplete) return;

		if (isLastStep) {
			setIsComplete(true);
			clearStorage();
			onComplete?.(answers);
			return;
		}

		const nextIndex = currentStepIndex + 1;
		const nextStep = STEP_ORDER[nextIndex];
		if (nextIndex < totalSteps && nextStep !== undefined) {
			setCurrentStep(nextStep);
		}
	}, [
		canGoNext,
		isComplete,
		isLastStep,
		currentStepIndex,
		totalSteps,
		answers,
		onComplete,
	]);

	const goBack = useCallback(() => {
		if (isFirstStep || isComplete) return;

		const prevIndex = currentStepIndex - 1;
		const prevStep = STEP_ORDER[prevIndex];
		if (prevIndex >= 0 && prevStep !== undefined) {
			setCurrentStep(prevStep);
		}
	}, [isFirstStep, isComplete, currentStepIndex]);

	const skip = useCallback(() => {
		if (!stepConfig.skippable || isComplete) return;

		if (isLastStep) {
			setIsComplete(true);
			clearStorage();
			onComplete?.(answers);
			return;
		}

		const nextIndex = currentStepIndex + 1;
		const nextStep = STEP_ORDER[nextIndex];
		if (nextIndex < totalSteps && nextStep !== undefined) {
			setCurrentStep(nextStep);
		}
	}, [
		stepConfig.skippable,
		isComplete,
		isLastStep,
		currentStepIndex,
		totalSteps,
		answers,
		onComplete,
	]);

	const goToStep = useCallback(
		(step: QuestionnaireStep) => {
			if (isComplete) return;

			const targetIndex = STEP_ORDER.indexOf(step);
			if (targetIndex === -1) return;

			for (let i = 0; i < targetIndex; i++) {
				const checkStep = STEP_ORDER[i];
				if (checkStep === undefined) continue;
				const config = STEP_CONFIGS[checkStep];
				if (config.required && !validateStep(checkStep, answers)) {
					setCurrentStep(checkStep);
					return;
				}
			}

			setCurrentStep(step);
		},
		[isComplete, answers],
	);

	const setAnswer = useCallback(
		<K extends keyof QuestionnaireAnswers>(
			field: K,
			value: QuestionnaireAnswers[K],
		) => {
			setAnswers((prev) => ({
				...prev,
				[field]: value,
			}));
		},
		[],
	);

	const reset = useCallback(() => {
		setAnswers(INITIAL_ANSWERS);
		setCurrentStep("url");
		setIsComplete(false);
		clearStorage();
	}, []);

	return useMemo(
		() => ({
			currentStep,
			currentStepIndex,
			totalSteps,
			stepConfig,
			answers,
			isFirstStep,
			isLastStep,
			canGoNext,
			hasUrl,
			isComplete,

			goNext,
			goBack,
			skip,
			goToStep,
			setAnswer,
			reset,
		}),
		[
			currentStep,
			currentStepIndex,
			totalSteps,
			stepConfig,
			answers,
			isFirstStep,
			isLastStep,
			canGoNext,
			hasUrl,
			isComplete,
			goNext,
			goBack,
			skip,
			goToStep,
			setAnswer,
			reset,
		],
	);
}
