export const getGoogleDriveVideoNames = (title?: string | null) => {
	if (!title?.trim() || /\p{Cc}/u.test(title)) {
		return null;
	}

	return {
		folderName: title,
		fileName: /\.mp4$/i.test(title) ? title : `${title}.mp4`,
	};
};
