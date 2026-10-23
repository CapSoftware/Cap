"use client";

import { type ReactNode, useState } from "react";
import { BarRow, Chart, Headline, Tabs } from "./shared";

type Scenario = "windows" | "prores1080" | "prores4k";

/** Seconds to export, before and after 0.6.1, as measured in each PR. */
const SCENARIOS: Record<
	Scenario,
	{
		before: number;
		after: number;
		subtitle: string;
		caption: ReactNode;
	}
> = {
	windows: {
		before: 99.5,
		after: 20.5,
		subtitle: "An 83 second recording to MP4 at 1080p60, on Windows",
		caption: (
			<>
				Windows 11 on a laptop with an i7-12800H and an RTX 3080 Ti. The speedup
				is mostly Hona's work in <PR number={2439} />, <PR number={2448} /> and{" "}
				<PR number={2450} />.
			</>
		),
	},
	prores1080: {
		before: 1800 / 13.2,
		after: 1800 / 54.3,
		subtitle: "A minute of ProRes at 1080p30, on an Apple M5",
		caption: (
			<>
				13.2 frames a second before, 54.3 after, with a bit-for-bit identical
				file. Measured by Aqua-123 in <PR number={2528} />.
			</>
		),
	},
	prores4k: {
		before: 1800 / 3.2,
		after: 1800 / 11.8,
		subtitle: "A minute of ProRes at 4K30, on an Apple M5",
		caption: (
			<>
				3.2 frames a second before, 11.8 after, with a bit-for-bit identical
				file. Measured by Aqua-123 in <PR number={2528} />.
			</>
		),
	},
};

const OPTIONS = [
	{ value: "windows", label: "Windows MP4" },
	{ value: "prores1080", label: "ProRes 1080p" },
	{ value: "prores4k", label: "ProRes 4K" },
] as const;

function PR({ number }: { number: number }) {
	return (
		<a
			href={`https://github.com/CapSoftware/Cap/pull/${number}`}
			className="text-gray-11 underline decoration-gray-6 underline-offset-2 hover:text-gray-12"
		>
			#{number}
		</a>
	);
}

function formatSeconds(total: number) {
	if (total < 100) return `${total.toFixed(1).replace(/\.0$/, "")} s`;
	const rounded = Math.round(total);
	return `${Math.floor(rounded / 60)} min ${rounded % 60} s`;
}

export function ExportRace() {
	const [scenario, setScenario] = useState<Scenario>("windows");
	const run = SCENARIOS[scenario];

	return (
		<Chart
			title="Export time"
			subtitle={run.subtitle}
			controls={
				<Tabs
					label="Export"
					options={OPTIONS}
					value={scenario}
					onChange={setScenario}
				/>
			}
			caption={run.caption}
		>
			<div className="grid items-end gap-x-14 gap-y-6 pt-8 md:grid-cols-[13rem_minmax(0,1fr)]">
				<Headline
					value={`${(run.before / run.after).toFixed(1)}×`}
					label="faster than 0.6.0"
				/>
				<div>
					<BarRow
						name="Cap 0.6.0"
						value={formatSeconds(run.before)}
						share={1}
					/>
					<BarRow
						name="Cap 0.6.1"
						value={formatSeconds(run.after)}
						share={run.after / run.before}
						highlight
					/>
				</div>
			</div>
		</Chart>
	);
}
