export const legacyActivationQuery = `
	SELECT
		EXISTS(SELECT 1 FROM videos WHERE "ownerId" = $1 LIMIT 1) AS "hasVideo",
		EXISTS(SELECT 1 FROM videos WHERE "ownerId" = $1 AND public = true LIMIT 1) AS "hasSharedVideo"
`;

export const activationQuery = `
	SELECT
		MAX(CASE WHEN u.video_id IS NOT NULL OR (j.video_id IS NOT NULL AND j.state <> 'verified') THEN 1 ELSE 0 END) AS "hasPendingUpload",
		MAX(CASE WHEN u.video_id IS NULL
			AND v.duration > 0
			AND (j.state = 'verified' OR (j.video_id IS NULL AND (
				(jsonb_typeof(v.source -> 'outputKey') = 'string'
				AND NULLIF(v.source ->> 'outputKey', '') IS NOT NULL)
				OR v."jobStatus" = 'COMPLETE'
			))) THEN 1 ELSE 0 END) AS "hasVideo",
		MAX(CASE WHEN u.video_id IS NULL
			AND v.duration > 0
			AND (j.state = 'verified' OR (j.video_id IS NULL AND (
				(jsonb_typeof(v.source -> 'outputKey') = 'string'
				AND NULLIF(v.source ->> 'outputKey', '') IS NOT NULL)
				OR v."jobStatus" = 'COMPLETE'
			))) AND v."firstViewEmailSentAt" IS NOT NULL THEN 1 ELSE 0 END) AS "hasSharedVideo",
		MAX(GREATEST(v."createdAt" + interval '5 minutes', COALESCE(v."firstViewEmailSentAt", v."createdAt"))) AS "lastActivationNotificationAt"
	FROM videos v
	LEFT JOIN video_uploads u ON u.video_id = v.id
	LEFT JOIN video_processing_jobs j ON j.video_id = v.id
	WHERE v."ownerId" = $1 AND v."isScreenshot" = false
`;
