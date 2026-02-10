export type UploadStatus =
	| { status: "parsing" }
	| { status: "creating" }
	| {
			status: "converting";
			capId: string;
			progress: number;
	  }
	| {
			status: "uploadingThumbnail";
			capId: string;
			progress: number;
	  }
	| {
			status: "uploadingVideo";
			capId: string;
			progress: number;
			thumbnailUrl: string | undefined;
	  }
	| { status: "serverProcessing"; capId: string };
