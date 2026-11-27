"use client";

import dynamic from "next/dynamic";

export const ShareLoader = dynamic(() =>
	import("./Share").then((module) => module.Share),
);

export const NoteShareLoader = dynamic(() =>
	import("./NoteShare").then((module) => module.NoteShare),
);
