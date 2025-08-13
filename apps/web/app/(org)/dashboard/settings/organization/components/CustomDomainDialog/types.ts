export enum StepStatus {
	PENDING = "pending",
	CURRENT = "current",
	COMPLETED = "completed",
}

export interface StepConfig {
	id: string;
	name: string;
	description?: string;
}

export interface StepState {
	currentIndex: number;
	totalSteps: number;
	canNavigateBack: boolean;
	errors: Record<string, string>;
}

export type StepAction =
	| { type: "NEXT_STEP" }
	| { type: "PREV_STEP" }
	| { type: "GO_TO_STEP"; payload: number }
	| { type: "SET_ERROR"; payload: { stepId: string; error: string } }
	| { type: "CLEAR_ERROR"; payload: string }
	| { type: "RESET" };

export type DomainVerification = {
	type: string;
	domain: string;
	value: string;
	reason: string;
};

export type DomainConfig = {
	name: string;
	apexName: string;
	verification: DomainVerification[];
	verified: boolean;
	misconfigured?: boolean;
	aValues?: string[];
	currentAValues?: string[];
	requiredAValue?: string;
	cnameValue?: string;
	currentCnameValue?: string;
	requiredCnameValue?: string;
	isSubdomain?: boolean;
	recommendedCNAME?: Array<{ rank: number; value: string }>;
	recommendedIPv4?: Array<{ rank: number; value: string[] | string }>;
	cnames?: string[];
};
