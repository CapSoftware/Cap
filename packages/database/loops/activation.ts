export const activationQuery = `
	SELECT
		MAX(CASE WHEN u.video_id IS NOT NULL OR (j.video_id IS NOT NULL AND j.state <> 'verified') THEN 1 ELSE 0 END) AS hasPendingUpload,
		MAX(CASE WHEN u.video_id IS NULL
			AND v.duration > 0
			AND (j.state = 'verified' OR (j.video_id IS NULL AND (
				(JSON_TYPE(JSON_EXTRACT(v.source, '$.outputKey')) = 'STRING'
				AND NULLIF(JSON_UNQUOTE(JSON_EXTRACT(v.source, '$.outputKey')), '') IS NOT NULL)
				OR v.jobStatus = 'COMPLETE'
			))) THEN 1 ELSE 0 END) AS hasVideo,
		MAX(CASE WHEN u.video_id IS NULL
			AND v.duration > 0
			AND (j.state = 'verified' OR (j.video_id IS NULL AND (
				(JSON_TYPE(JSON_EXTRACT(v.source, '$.outputKey')) = 'STRING'
				AND NULLIF(JSON_UNQUOTE(JSON_EXTRACT(v.source, '$.outputKey')), '') IS NOT NULL)
				OR v.jobStatus = 'COMPLETE'
			))) AND v.firstViewEmailSentAt IS NOT NULL THEN 1 ELSE 0 END) AS hasSharedVideo,
		MAX(GREATEST(DATE_ADD(v.createdAt, INTERVAL 5 MINUTE), COALESCE(v.firstViewEmailSentAt, v.createdAt))) AS lastActivationNotificationAt
	FROM videos v
	LEFT JOIN video_uploads u ON u.video_id = v.id
	LEFT JOIN video_processing_jobs j ON j.video_id = v.id
	WHERE v.ownerId = ? AND v.isScreenshot = 0
`;
