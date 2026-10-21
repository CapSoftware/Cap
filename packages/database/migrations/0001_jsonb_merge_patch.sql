CREATE OR REPLACE FUNCTION jsonb_merge_patch(target jsonb, patch jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE
		WHEN jsonb_typeof(patch) IS DISTINCT FROM 'object' THEN patch
		ELSE COALESCE((
			SELECT jsonb_object_agg(merged.key, merged.value)
			FROM (
				SELECT
					COALESCE(t.key, p.key) AS key,
					CASE WHEN p.key IS NULL THEN t.value ELSE jsonb_merge_patch(t.value, p.value) END AS value
				FROM jsonb_each(CASE WHEN jsonb_typeof(target) = 'object' THEN target ELSE '{}'::jsonb END) AS t
				FULL JOIN jsonb_each(patch) AS p ON t.key = p.key
				WHERE p.value IS DISTINCT FROM 'null'::jsonb
			) AS merged
		), '{}'::jsonb)
	END
$$;
