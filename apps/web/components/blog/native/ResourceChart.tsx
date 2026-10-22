"use client";

import { useState } from "react";
import { BarRow, Chart, Headline, Tabs } from "./shared";

type Workload = "playback" | "recording";

type Sample = { cpu: number; memory: number };

type AppKey = "tauri" | "electron" | "native";

type App = { key: AppKey; name: string; detail: string };

const APPS: App[] = [
	{ key: "tauri", name: "Tauri", detail: "0.6.0" },
	{ key: "electron", name: "Electron", detail: "experiment" },
	{ key: "native", name: "GPUI", detail: "first build" },
];

/** PR #2133: M4 Max, release builds, one warm-up and four trials each. */
const DATA: Record<Workload, Record<AppKey, Sample>> = {
	playback: {
		tauri: { cpu: 76.6, memory: 3724 },
		electron: { cpu: 53.2, memory: 1035 },
		native: { cpu: 17.5, memory: 440 },
	},
	recording: {
		tauri: { cpu: 37.6, memory: 1983 },
		electron: { cpu: 31.7, memory: 805 },
		native: { cpu: 20.3, memory: 256 },
	},
};

const OPTIONS = [
	{ value: "playback", label: "Playing back" },
	{ value: "recording", label: "Recording" },
] as const;

function formatMemory(mib: number) {
	return mib >= 1000
		? `${(mib / 1024).toFixed(1)} GB`
		: `${Math.round(mib)} MB`;
}

export function ResourceChart() {
	const [workload, setWorkload] = useState<Workload>("playback");
	const data = DATA[workload];
	const cpuMax = Math.max(...APPS.map((app) => data[app.key].cpu));
	const memoryMax = Math.max(...APPS.map((app) => data[app.key].memory));

	return (
		<Chart
			title="Three builds of Cap, one recording"
			subtitle={
				workload === "playback"
					? "While playing back in the editor"
					: "While recording"
			}
			controls={
				<Tabs
					label="Workload"
					options={OPTIONS}
					value={workload}
					onChange={setWorkload}
				/>
			}
			caption="Measured in August on an M4 Max, with release builds, one warm-up and four runs of each."
		>
			<div className="grid gap-x-14 gap-y-10 pt-8 md:grid-cols-2">
				{(["cpu", "memory"] as const).map((metric) => {
					const max = metric === "cpu" ? cpuMax : memoryMax;
					const saved = 1 - data.native[metric] / data.tauri[metric];
					return (
						<div key={metric}>
							<Headline
								value={`${Math.round(saved * 100)}%`}
								label={
									metric === "cpu"
										? "less CPU than Tauri"
										: "less memory than Tauri"
								}
							/>
							<div className="mt-6">
								{APPS.map((app) => {
									const value = data[app.key][metric];
									return (
										<BarRow
											key={app.key}
											name={app.name}
											detail={app.detail}
											value={
												metric === "cpu" ? `${value}%` : formatMemory(value)
											}
											share={value / max}
											highlight={app.key === "native"}
										/>
									);
								})}
							</div>
						</div>
					);
				})}
			</div>

			<table className="sr-only">
				<caption>
					CPU and memory while{" "}
					{workload === "playback" ? "playing back in the editor" : "recording"}
				</caption>
				<thead>
					<tr>
						<th>App</th>
						<th>CPU</th>
						<th>Memory</th>
					</tr>
				</thead>
				<tbody>
					{APPS.map((app) => (
						<tr key={app.key}>
							<td>{app.name}</td>
							<td>{data[app.key].cpu}%</td>
							<td>{data[app.key].memory} MiB</td>
						</tr>
					))}
				</tbody>
			</table>
		</Chart>
	);
}
