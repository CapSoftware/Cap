WITH 
    tenant_domains AS (
        SELECT 
            tenant_id,
            domain
        FROM (
            SELECT 
                'tenant_1' AS tenant_id, 'example.com' AS domain UNION ALL
                SELECT 'tenant_2', 'myapp.com' UNION ALL
                SELECT 'tenant_3', 'demo.site' UNION ALL
                SELECT 'tenant_8', 'test.org' UNION ALL
                SELECT 'tenant_14', 'app.demo.io' UNION ALL
                SELECT 'tenant_16', 'example.com' UNION ALL
                SELECT 'tenant_17', 'demo.site' UNION ALL
                SELECT 'tenant_18', 'test.org' UNION ALL
                SELECT 'tenant_10', 'myapp.com' UNION ALL
                SELECT '', '' UNION ALL
                SELECT '', 'example.com' UNION ALL
                SELECT 'tenant_1', ''
        )
    ),
    versions AS (
        SELECT arrayJoin(['v1.0.0', 'v1.1.0', 'v2.0.0', 'v2.1.0', 'v3.0.0', 'v3.1.0', 'v3.2.1']) AS version
    ),
    pathnames AS (
        SELECT arrayJoin(['/', '/home', '/about', '/pricing', '/contact', '/blog', '/login', '/product']) AS pathname
    ),
    referrers AS (
        SELECT arrayJoin(['https://google.com', 'https://facebook.com', 'https://twitter.com', 'https://linkedin.com', '']) AS referrer
    ),
    user_agents AS (
        SELECT arrayJoin([
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36', 
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'
        ]) AS user_agent
    ),
    locales AS (
        SELECT arrayJoin(['en-US', 'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'zh-CN']) AS locale
    ),
    countries AS (
        SELECT arrayJoin(['United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Spain', 'Italy', 'Japan', 'China']) AS country
    ),
    cities AS (
        SELECT arrayJoin(['New York', 'London', 'Paris', 'Berlin', 'Madrid', 'Tokyo', 'Beijing', 'Los Angeles', 'Boston']) AS city
    ),
    web_vital_names AS (
        SELECT arrayJoin(['LCP', 'TTFB', 'FCP', 'INP', 'CLS']) AS name
    )
SELECT
    toDateTime('2025-07-17') - rand() % (86400 * 365) AS timestamp,
    case when rand() % 10 > 0 then concat('sessionid', toString(rand() % 900 + 100), '-', toString(rand() % 900 + 100), '-', toString(rand() % 900 + 100), '-abc-def', toString(rand() % 900000 + 100000)) else NULL end AS session_id,
    if(rand() % 2 = 0, 'page_hit', 'web_vital') AS action,
    (SELECT version FROM versions ORDER BY rand() LIMIT 1) AS version,
    if(
        rand() % 2 = 0,
        -- page_hit payload
        concat('{
            "pathname": "', p.pathname, '",
            "href": "https://', td.domain, p.pathname, '", 
            "referrer": "', r.referrer, '",
            "userAgent": "', ua.user_agent, '",
            "locale": "', l.locale, '",
            "location": {
                "country": "', co.country, '",
                "city": "', ci.city, '"
            }
        }'),
        -- web_vital payload
        concat('{
            "name": "', wvn.name, '",
            "value": ', 
            case 
                when wvn.name = 'LCP' then toString(1500 + rand() % 3000)
                when wvn.name = 'TTFB' then toString(200 + rand() % 1000)
                when wvn.name = 'FCP' then toString(800 + rand() % 2400)
                when wvn.name = 'INP' then toString(100 + rand() % 500)
                when wvn.name = 'CLS' then toString(round(0.05 + rand() / 1000000000 * 0.3, 2))
                else '0'
            end,
            ',
            "delta": ', toString(50 + rand() % 150), ',
            "pathname": "', p.pathname, '",
            "domain": "', td.domain, '"
        }')
    ) AS payload,
    td.tenant_id AS tenant_id,
    td.domain AS domain
FROM 
    numbers(12000),
    (SELECT * FROM tenant_domains ORDER BY rand() LIMIT 1) AS td,
    (SELECT * FROM pathnames ORDER BY rand() LIMIT 1) AS p,
    (SELECT * FROM referrers ORDER BY rand() LIMIT 1) AS r,
    (SELECT * FROM user_agents ORDER BY rand() LIMIT 1) AS ua,
    (SELECT * FROM locales ORDER BY rand() LIMIT 1) AS l,
    (SELECT * FROM countries ORDER BY rand() LIMIT 1) AS co,
    (SELECT * FROM cities ORDER BY rand() LIMIT 1) AS ci,
    (SELECT * FROM web_vital_names ORDER BY rand() LIMIT 1) AS wvn
