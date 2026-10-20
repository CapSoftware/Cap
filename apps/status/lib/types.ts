export type Health = "operational" | "degraded" | "outage" | "unknown";

export type Day = {
	date: string;
	operational: number;
	degraded: number;
	outage: number;
};

export type Incident = {
	id: string;
	serviceId: string;
	severity: "degraded" | "outage";
	startedAt: string;
	resolvedAt: string | null;
};

export type ServiceState = {
	status: Health;
	checkedAt: string | null;
	latencyMs: number | null;
	failures: number;
	successes: number;
	issueStartedAt: string | null;
	incidentId: string | null;
	days: Day[];
};

export type MonitorState = {
	version: 1;
	checkedAt: string | null;
	services: Record<string, ServiceState>;
	incidents: Incident[];
};

export type ServiceDefinition = {
	id: string;
	name: string;
	description: string;
	env: string;
	defaultUrl?: string;
	method: "GET" | "HEAD";
	validation?: "auth" | "media" | "render";
};

export type PublicService = Pick<
	ServiceDefinition,
	"id" | "name" | "description"
> & {
	status: Health;
	checkedAt: string | null;
	latencyMs: number | null;
	configured: boolean;
	days: Day[];
};

export type Snapshot = {
	checkedAt: string | null;
	services: PublicService[];
	incidents: Incident[];
};

export type ProbeResult = {
	status: Exclude<Health, "unknown">;
	latencyMs: number;
};
