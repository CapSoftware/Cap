"use client";

import dynamic from "next/dynamic";

export const RecordingPublisher = dynamic(
	() => import("./recording-publisher").then((m) => m.RecordingPublisher),
	{ ssr: false },
);
