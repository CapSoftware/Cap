export type AnalyticsRange = "24h" | "7d" | "30d";

export interface BreakdownRow {
	name: string;
	subtitle?: string | null;
	views: number;
	percentage: number;
}

export interface OrgAnalyticsResponse {
	counts: {
		caps: number;
		views: number;
		comments: number;
		reactions: number;
	};
	chart: Array<{
		bucket: string;
		caps: number;
		views: number;
		comments: number;
		reactions: number;
	}>;
	breakdowns: {
		countries: BreakdownRow[];
		cities: BreakdownRow[];
		browsers: BreakdownRow[];
		operatingSystems: BreakdownRow[];
		devices: BreakdownRow[];
		topCaps: Array<BreakdownRow & { id: string }>;
	};
	capName?: string;
}
