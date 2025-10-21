# Tinybird Data Project

## Project structure

```
web-analytics-starter-kit/tinybird/
├── datasources
│   ├── analytics_events.datasource
│   ├── analytics_pages_mv.datasource
│   ├── analytics_sessions_mv.datasource
│   └── analytics_sources_mv.datasource
├── endpoints
│   ├── analytics_hits.pipe
│   ├── current_visitors.pipe
│   ├── domain.pipe
│   ├── kpis.pipe
│   ├── top_browsers.pipe
│   ├── top_devices.pipe
│   ├── top_locations.pipe
│   ├── top_pages.pipe
│   ├── top_sources.pipe
│   └── trend.pipe
├── materializations
│   ├── analytics_pages.pipe
│   ├── analytics_sessions.pipe
│   └── analytics_sources.pipe
├── web_vitals
│   ├── web_vitals_current.pipe
│   ├── web_vitals_distribution.pipe
│   └── web_vitals_routes.pipe
├── fixtures
│   ├── analytics_events.ndjson
│   └── analytics_events.sql
├── tests
├── .gitignore
├── .cursorrules
├── CLAUDE.md
└── README.md
```

### Folder descriptions

- **datasources/**: Contains all datasource definitions, including the main analytics_events datasource and materialized view datasources.
- **endpoints/**: Contains all API pipes/endpoints for web analytics, such as analytics_hits, kpis, top_browsers, top_devices, top_locations, top_pages, top_sources, trend, current_visitors, and domain.
- **materializations/**: Contains materialized view pipes for analytics_pages, analytics_sessions, and analytics_sources.
- **web_vitals/**: Contains API pipes/endpoints for web vitals metrics.
- **tests/**: Contains tests.
- **fixtures/**: Contains data and SQL for analytics_events.
- **.gitignore, .cursorrules, CLAUDE.md, README.md**: Project configuration and documentation files.

## Project description

The Tinybird data project for web analytics includes datasources, endpoints, and materializations to power analytics dashboards and APIs. The main datasource, `analytics_events`, collects events from the tracker script. Endpoints provide parsed and aggregated analytics, and materializations enable efficient querying for dashboards.

`web_vitals` metrics are stored in `analytics_events` with `action=web_vital`. See `web_vitals` folder for example endpoints.

## Local development

```bash
# install the tinybird CLI
curl https://tinybird.co | sh

tb local start

# select or create a new workspace
tb login

tb dev
tb token ls  # copy the local admin token
```

Use `http://localhost:7181` as NEXT_PUBLIC_TINYBIRD_HOST and the admin token in the [dashboard](../dashboard/README.md).

## Cloud deployment

After validating your changes use `tb --cloud deploy`
