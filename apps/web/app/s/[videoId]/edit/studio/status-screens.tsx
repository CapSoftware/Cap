"use client";

import dynamic from "next/dynamic";

// The editor page only shows these while a recording is still processing or
// needs recovery. The processing screen's progress ring brings the Effect RPC
// runtime, so neither is downloaded when the editor opens normally.
export const EditProcessing = dynamic(() =>
	import("../edit-processing").then((module) => module.EditProcessing),
);

export const EditRecovery = dynamic(() =>
	import("../edit-recovery").then((module) => module.EditRecovery),
);
