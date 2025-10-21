
# Tinybird CLI rules

## Commands
You have commands at your disposal to develop a tinybird project:
- tb build: to build the project locally and check it works.
- tb deployment create --wait --auto: to create a deployment and promote it automatically
- tb test run: to run existing tests
- tb endpoint url <pipe_name>: to get the url of an endpoint, token included.
- tb endpoint data <pipe_name>: to get the data of an endpoint. You can pass parameters to the endpoint like this: tb endpoint data <pipe_name> --param1 value1 --param2 value2
- tb  token ls: to list all the tokens
There are other commands that you can use, but these are the most common ones. Run `tb -h` to see all the commands if needed.
When you need to work with resources or data in cloud, add always the --cloud flag before the command. Example: tb --cloud datasource ls

## Development instructions
- When asking to create a tinybird data project, if the needed folders are not already created, use the following structure:
├── connections
├── copies
├── sinks
├── datasources
├── endpoints
├── fixtures
├── materializations
├── pipes
└── tests
- The local development server will be available at http://localhost:7181. Even if some response uses another base url, use always http://localhost:7181.
- After every change in your .datasource, .pipe or .ndjson files, run `tb build` to build the project locally.
- When you need to ingest data locally in a datasource, create a .ndjson file with the same name of the datasource and the data you want and run `tb build` so the data is ingested.
- The format of the generated api endpoint urls is: http://localhost:7181/v0/pipe/<pipe_name>.json?token=<token>
- Before running the tests, remember to have the project built with `tb build` with the latest changes.
</development_instructions>
When asking for ingesting data, adding data or appending data do the following depending on the environment you want to work with:

## Ingestion instructions
- When building locally, create a .ndjson file with the data you want to ingest and do `tb build` to ingest the data in the build env.
- We call `cloud` the production environment.
- When appending data in cloud, use `tb --cloud datasource append <datasource_name> <file_name>`
- When you have a response that says “there are rows in quarantine”, do `tb [--cloud] datasource data <datasource_name>_quarantine` to understand what is the problem.

## .datasource file instructions
Follow these instructions when creating or updating .datasource files:

<datasource_file_instructions>
    - Content cannot be empty.
    - The datasource names must be unique.
    - No indentation is allowed for property names: DESCRIPTION, SCHEMA, ENGINE, ENGINE_PARTITION_KEY, ENGINE_SORTING_KEY, etc.
    - Use MergeTree engine by default.
    - Use AggregatingMergeTree engine when the datasource is the target of a materialized pipe.
    - Use always json paths to define the schema. Example: `user_id` String `json:$.user_id`,
    - Array columns are supported with a special syntax. Example: `items` Array(String) `json:$.items[:]`
    - If the datasource is using an S3 or GCS connection, they need to set IMPORT_CONNECTION_NAME, IMPORT_BUCKET_URI and IMPORT_SCHEDULE (GCS @on-demand only, S3 supports @auto too)
    - Unless the user asks for them, do not include ENGINE_PARTITION_KEY and ENGINE_PRIMARY_KEY.
    - DateTime64 type without precision is not supported. Use DateTime64(3) instead.
</datasource_file_instructions>


## .pipe file instructions
Follow these instructions when creating or updating .pipe files:

Follow these instructions when creating or updating any type of .pipe file:
<pipe_file_instructions>
    - The pipe names must be unique.
    - Nodes do NOT use the same name as the Pipe they belong to. So if the pipe name is "my_pipe", the nodes must be named different like "my_pipe_node_1", "my_pipe_node_2", etc.
    - Node names MUST be different from the resource names in the project.
    - No indentation is allowed for property names: DESCRIPTION, NODE, SQL, TYPE, etc.
    - Allowed TYPE values are: endpoint, copy, materialized, sink.
    - Add always the output node in the TYPE section or in the last node of the pipe.
</pipe_file_instructions>


<sql_instructions>
    - The SQL query must be a valid ClickHouse SQL query that mixes ClickHouse syntax and Tinybird templating syntax (Tornado templating language under the hood).
    - SQL queries with parameters must start with "%" character and a newline on top of every query to be able to use the parameters. Examples:
    <invalid_query_with_parameters_no_%_on_top>
    SELECT * FROM events WHERE session_id={{String(my_param, "default_value")}}
    </invalid_query_with_parameters_no_%_on_top>
    <valid_query_with_parameters_with_%_on_top>
    %
    SELECT * FROM events WHERE session_id={{String(my_param, "default_value")}}
    </valid_query_with_parameters_with_%_on_top>
    - The Parameter functions like this one {{String(my_param_name,default_value)}} can be one of the following: String, DateTime, Date, Float32, Float64, Int, Integer, UInt8, UInt16, UInt32, UInt64, UInt128, UInt256, Int8, Int16, Int32, Int64, Int128, Int256
    - Parameter names must be different from column names. Pass always the param name and a default value to the function.
    - Use ALWAYS hardcoded values for default values for parameters.
    - Code inside the template {{template_expression}} follows the rules of Tornado templating language so no module is allowed to be imported. So for example you can't use now() as default value for a DateTime parameter. You need an if else block like this:
    <invalid_condition_with_now>
    AND timestamp BETWEEN {DateTime(start_date, now() - interval 30 day)} AND {DateTime(end_date, now())}
    </invalid_condition_with_now>
    <valid_condition_without_now>
    {%if not defined(start_date)%}
    timestamp BETWEEN now() - interval 30 day
    {%else%}
    timestamp BETWEEN {{DateTime(start_date)}}
    {%end%}
    {%if not defined(end_date)%}
    AND now()
    {%else%}
    AND {{DateTime(end_date)}}
    {%end%}
    </valid_condition_without_now>
    - Parameters must not be quoted.
    - When you use defined function with a paremeter inside, do NOT add quotes around the parameter:
    <invalid_defined_function_with_parameter>{% if defined('my_param') %}</invalid_defined_function_with_parameter>
    <valid_defined_function_without_parameter>{% if defined(my_param) %}</valid_defined_function_without_parameter>
    - Use datasource names as table names when doing SELECT statements.
    - Do not use pipe names as table names.
    - The available datasource names to use in the SQL are the ones present in the existing_resources section or the ones you will create.
    - Use node names as table names only when nodes are present in the same file.
    - Do not reference the current node name in the SQL.
    - SQL queries only accept SELECT statements with conditions, aggregations, joins, etc.
    - Do NOT use CREATE TABLE, INSERT INTO, CREATE DATABASE, etc.
    - Use ONLY SELECT statements in the SQL section.
    - INSERT INTO is not supported in SQL section.
    - ClickHouse functions supported are:
        - General functions supported are: ['BLAKE3', 'CAST', 'CHARACTER_LENGTH', 'CHAR_LENGTH', 'CRC32', 'CRC32IEEE', 'CRC64', 'DATABASE', 'DATE', 'DATE_DIFF', 'DATE_FORMAT', 'DATE_TRUNC', 'DAY', 'DAYOFMONTH', 'DAYOFWEEK', 'DAYOFYEAR', 'FORMAT_BYTES', 'FQDN', 'FROM_BASE64', 'FROM_DAYS', 'FROM_UNIXTIME', 'HOUR', 'INET6_ATON', 'INET6_NTOA', 'INET_ATON', 'INET_NTOA', 'IPv4CIDRToRange', 'IPv4NumToString', 'IPv4NumToStringClassC', 'IPv4StringToNum', 'IPv4StringToNumOrDefault', 'IPv4StringToNumOrNull', 'IPv4ToIPv6', 'IPv6CIDRToRange', 'IPv6NumToString', 'IPv6StringToNum', 'IPv6StringToNumOrDefault', 'IPv6StringToNumOrNull', 'JSONArrayLength', 'JSONExtract', 'JSONExtractArrayRaw', 'JSONExtractBool', 'JSONExtractFloat', 'JSONExtractInt', 'JSONExtractKeys', 'JSONExtractKeysAndValues', 'JSONExtractKeysAndValuesRaw', 'JSONExtractRaw', 'JSONExtractString', 'JSONExtractUInt', 'JSONHas', 'JSONKey', 'JSONLength', 'JSONRemoveDynamoDBAnnotations', 'JSONType', 'JSON_ARRAY_LENGTH', 'JSON_EXISTS', 'JSON_QUERY', 'JSON_VALUE', 'L1Distance', 'L1Norm', 'L1Normalize', 'L2Distance', 'L2Norm', 'L2Normalize', 'L2SquaredDistance', 'L2SquaredNorm', 'LAST_DAY', 'LinfDistance', 'LinfNorm', 'LinfNormalize', 'LpDistance', 'LpNorm', 'LpNormalize', 'MACNumToString', 'MACStringToNum', 'MACStringToOUI', 'MAP_FROM_ARRAYS', 'MD4', 'MD5', 'MILLISECOND', 'MINUTE', 'MONTH', 'OCTET_LENGTH', 'QUARTER', 'REGEXP_EXTRACT', 'REGEXP_MATCHES', 'REGEXP_REPLACE', 'SCHEMA', 'SECOND', 'SHA1', 'SHA224', 'SHA256', 'SHA384', 'SHA512', 'SHA512_256', 'SUBSTRING_INDEX', 'SVG', 'TIMESTAMP_DIFF', 'TO_BASE64', 'TO_DAYS', 'TO_UNIXTIME', 'ULIDStringToDateTime', 'URLHash', 'URLHierarchy', 'URLPathHierarchy', 'UTCTimestamp', 'UTC_timestamp', 'UUIDNumToString', 'UUIDStringToNum', 'UUIDToNum', 'UUIDv7ToDateTime', 'YEAR', 'YYYYMMDDToDate', 'YYYYMMDDToDate32', 'YYYYMMDDhhmmssToDateTime', 'YYYYMMDDhhmmssToDateTime64']
        - Character insensitive functions supported are: ['cast', 'character_length', 'char_length', 'crc32', 'crc32ieee', 'crc64', 'database', 'date', 'date_format', 'date_trunc', 'day', 'dayofmonth', 'dayofweek', 'dayofyear', 'format_bytes', 'fqdn', 'from_base64', 'from_days', 'from_unixtime', 'hour', 'inet6_aton', 'inet6_ntoa', 'inet_aton', 'inet_ntoa', 'json_array_length', 'last_day', 'millisecond', 'minute', 'month', 'octet_length', 'quarter', 'regexp_extract', 'regexp_matches', 'regexp_replace', 'schema', 'second', 'substring_index', 'to_base64', 'to_days', 'to_unixtime', 'utctimestamp', 'utc_timestamp', 'year']
        - Aggregate functions supported are: ['BIT_AND', 'BIT_OR', 'BIT_XOR', 'COVAR_POP', 'COVAR_SAMP', 'STD', 'STDDEV_POP', 'STDDEV_SAMP', 'VAR_POP', 'VAR_SAMP', 'aggThrow', 'analysisOfVariance', 'anova', 'any', 'anyHeavy', 'anyLast', 'anyLast_respect_nulls', 'any_respect_nulls', 'any_value', 'any_value_respect_nulls', 'approx_top_count', 'approx_top_k', 'approx_top_sum', 'argMax', 'argMin', 'array_agg', 'array_concat_agg', 'avg', 'avgWeighted', 'boundingRatio', 'categoricalInformationValue', 'contingency', 'corr', 'corrMatrix', 'corrStable', 'count', 'covarPop', 'covarPopMatrix', 'covarPopStable', 'covarSamp', 'covarSampMatrix', 'covarSampStable', 'cramersV', 'cramersVBiasCorrected', 'deltaSum', 'deltaSumTimestamp', 'dense_rank', 'entropy', 'exponentialMovingAverage', 'exponentialTimeDecayedAvg', 'exponentialTimeDecayedCount', 'exponentialTimeDecayedMax', 'exponentialTimeDecayedSum', 'first_value', 'first_value_respect_nulls', 'flameGraph', 'groupArray', 'groupArrayInsertAt', 'groupArrayIntersect', 'groupArrayLast', 'groupArrayMovingAvg', 'groupArrayMovingSum', 'groupArraySample', 'groupArraySorted', 'groupBitAnd', 'groupBitOr', 'groupBitXor', 'groupBitmap', 'groupBitmapAnd', 'groupBitmapOr', 'groupBitmapXor', 'groupUniqArray', 'histogram', 'intervalLengthSum', 'kolmogorovSmirnovTest', 'kurtPop', 'kurtSamp', 'lagInFrame', 'largestTriangleThreeBuckets', 'last_value', 'last_value_respect_nulls', 'leadInFrame', 'lttb', 'mannWhitneyUTest', 'max', 'maxIntersections', 'maxIntersectionsPosition', 'maxMappedArrays', 'meanZTest', 'median', 'medianBFloat16', 'medianBFloat16Weighted', 'medianDD', 'medianDeterministic', 'medianExact', 'medianExactHigh', 'medianExactLow', 'medianExactWeighted', 'medianGK', 'medianInterpolatedWeighted', 'medianTDigest', 'medianTDigestWeighted', 'medianTiming', 'medianTimingWeighted', 'min', 'minMappedArrays', 'nonNegativeDerivative', 'nothing', 'nothingNull', 'nothingUInt64', 'nth_value', 'ntile', 'quantile', 'quantileBFloat16', 'quantileBFloat16Weighted', 'quantileDD', 'quantileDeterministic', 'quantileExact', 'quantileExactExclusive', 'quantileExactHigh', 'quantileExactInclusive', 'quantileExactLow', 'quantileExactWeighted', 'quantileGK', 'quantileInterpolatedWeighted', 'quantileTDigest', 'quantileTDigestWeighted', 'quantileTiming', 'quantileTimingWeighted', 'quantiles', 'quantilesBFloat16', 'quantilesBFloat16Weighted', 'quantilesDD', 'quantilesDeterministic', 'quantilesExact', 'quantilesExactExclusive', 'quantilesExactHigh', 'quantilesExactInclusive', 'quantilesExactLow', 'quantilesExactWeighted', 'quantilesGK', 'quantilesInterpolatedWeighted', 'quantilesTDigest', 'quantilesTDigestWeighted', 'quantilesTiming', 'quantilesTimingWeighted', 'rank', 'rankCorr', 'retention', 'row_number', 'sequenceCount', 'sequenceMatch', 'sequenceNextNode', 'simpleLinearRegression', 'singleValueOrNull', 'skewPop', 'skewSamp', 'sparkBar', 'sparkbar', 'stddevPop', 'stddevPopStable', 'stddevSamp', 'stddevSampStable', 'stochasticLinearRegression', 'stochasticLogisticRegression', 'studentTTest', 'sum', 'sumCount', 'sumKahan', 'sumMapFiltered', 'sumMapFilteredWithOverflow', 'sumMapWithOverflow', 'sumMappedArrays', 'sumWithOverflow', 'theilsU', 'topK', 'topKWeighted', 'uniq', 'uniqCombined', 'uniqCombined64', 'uniqExact', 'uniqHLL12', 'uniqTheta', 'uniqUpTo', 'varPop', 'varPopStable', 'varSamp', 'varSampStable', 'welchTTest', 'windowFunnel']
    - How to use ClickHouse supported functions:
        - When using functions try always ClickHouse functions first, then SQL functions.
        - Do not use any ClickHouse function that is not present in the list of general functions, character insensitive functions and aggregate functions.
        - If the function is not present in the list, the sql query will fail, so avoid at all costs to use any function that is not present in the list.
        - When aliasing a column, use first the column name and then the alias.
        - General functions and aggregate functions are case sensitive.
        - Character insensitive functions are case insensitive.
    - Parameters are never quoted in any case.
    - Use the following syntax in the SQL section for the iceberg table function: iceberg('s3://bucket/path/to/table', {{tb_secret('aws_access_key_id')}}, {{tb_secret('aws_secret_access_key')}})
    - Use the following syntax in the SQL section for the postgres table function: postgresql('host:port', 'database', 'table', {{tb_secret('db_username')}}, {{tb_secret('db_password')}}), 'schema')
</sql_instructions>


<datasource_content>
DESCRIPTION >
    Some meaningful description of the datasource

SCHEMA >
    `column_name_1` clickhouse_tinybird_compatible_data_type `json:$.column_name_1`,
    `column_name_2` clickhouse_tinybird_compatible_data_type `json:$.column_name_2`,
    ...
    `column_name_n` clickhouse_tinybird_compatible_data_type `json:$.column_name_n`

ENGINE "MergeTree"
ENGINE_PARTITION_KEY "partition_key"
ENGINE_SORTING_KEY "sorting_key_1, sorting_key_2, ..."
</datasource_content>


<pipe_content>
DESCRIPTION >
    Some meaningful description of the pipe

NODE node_1
SQL >
    [sql query using clickhouse syntax and tinybird templating syntax and starting always with SELECT or %
SELECT]
TYPE endpoint

</pipe_content>


<copy_pipe_instructions>
- Do not create copy pipes by default, unless the user asks for it.
- Copy pipes should be created in the /copies folder.
- In a .pipe file you can define how to export the result of a Pipe to a Data Source, optionally with a schedule.
- Do not include COPY_SCHEDULE in the .pipe file unless is specifically requested by the user.
- COPY_SCHEDULE is a cron expression that defines the schedule of the copy pipe.
- COPY_SCHEDULE is optional and if not provided, the copy pipe will be executed only once.
- TARGET_DATASOURCE is the name of the Data Source to export the result to.
- TYPE COPY is the type of the pipe and it is mandatory for copy pipes.
- If the copy pipe uses parameters, you must include the % character and a newline on top of every query to be able to use the parameters.
- The content of the .pipe file must follow this format:
DESCRIPTION Copy Pipe to export sales hour every hour to the sales_hour_copy Data Source

NODE daily_sales
SQL >
    %
    SELECT toStartOfDay(starting_date) day, country, sum(sales) as total_sales
    FROM teams
    WHERE
    day BETWEEN toStartOfDay(now()) - interval 1 day AND toStartOfDay(now())
    and country = {{ String(country, 'US')}}
    GROUP BY day, country

TYPE COPY
TARGET_DATASOURCE sales_hour_copy
COPY_SCHEDULE 0 * * * *
</copy_pipe_instructions>


<materialized_pipe_instructions>
- Do not create materialized pipes by default, unless the user asks for it.
- Materialized pipes should be created in the /materializations folder.
- In a .pipe file you can define how to materialize each row ingested in the earliest Data Source in the Pipe query to a materialized Data Source. Materialization happens at ingest.
- DATASOURCE: Required when TYPE is MATERIALIZED. Sets the target Data Source for materialized nodes.
- TYPE MATERIALIZED is the type of the pipe and it is mandatory for materialized pipes.
- The content of the .pipe file must follow the materialized_pipe_content format.
- Use State modifier for the aggregated columns in the pipe.
</materialized_pipe_instructions>
<materialized_pipe_content>
NODE daily_sales
SQL >
    SELECT toStartOfDay(starting_date) day, country, sumState(sales) as total_sales
    FROM teams
    GROUP BY day, country

TYPE MATERIALIZED
DATASOURCE sales_by_hour
</materialized_pipe_content>
<target_datasource_instructions>
- The target datasource of a materialized pipe must have an AggregatingMergeTree engine.
- Use AggregateFunction for the aggregated columns in the pipe.
- Pipes using a materialized data source must use the Merge modifier in the SQL query for the aggregated columns. Example: sumMerge(total_sales)
- Put all dimensions in the ENGINE_SORTING_KEY, sorted from least to most cardinality.
</target_datasource_instructions>
<target_datasource_content>
SCHEMA >
    `total_sales` AggregateFunction(sum, Float64),
    `sales_count` AggregateFunction(count, UInt64),
    `column_name_2` AggregateFunction(avg, Float64),
    `dimension_1` String,
    `dimension_2` String,
    ...
    `date` DateTime

ENGINE "AggregatingMergeTree"
ENGINE_PARTITION_KEY "toYYYYMM(date)"
ENGINE_SORTING_KEY "date, dimension_1, dimension_2, ..."
</target_datasource_content>


<sink_pipe_instructions>
- Do not create sink pipes by default, unless the user asks for it.
- Sink pipes should be created in the /sinks folder.
- In a .pipe file you can define how to export the result of a Pipe to an external system, optionally with a schedule.
- Valid external systems are Kafka, S3, GCS.
- Sink pipes depend on a connection, if no connection is provided, search for an existing connection that suits the request. If none, create a new connection.
- Do not include EXPORT_SCHEDULE in the .pipe file unless is specifically requested by the user.
- EXPORT_SCHEDULE is a cron expression that defines the schedule of the sink pipe.
- EXPORT_SCHEDULE is optional and if not provided, the sink pipe will be executed only once.
- EXPORT_CONNECTION_NAME is the name of the connection used to export.
- TYPE SINK is the type of the pipe and it is mandatory for sink pipes.
- If the sink pipe uses parameters, you must include the % character and a newline on top of every query to be able to use the parameters.
- The content of the .pipe file must follow this format:
DESCRIPTION Sink Pipe to export sales hour every hour using my_connection

NODE daily_sales
SQL >
    %
    SELECT toStartOfDay(starting_date) day, country, sum(sales) as total_sales
    FROM teams
    WHERE
    day BETWEEN toStartOfDay(now()) - interval 1 day AND toStartOfDay(now())
    and country = {{ String(country, 'US')}}
    GROUP BY day, country

TYPE sink
EXPORT_CONNECTION_NAME "my_connection"
EXPORT_BUCKET_URI "s3://tinybird-sinks"
EXPORT_FILE_TEMPLATE "daily_prices"
EXPORT_SCHEDULE "*/5 * * * *"
EXPORT_FORMAT "csv"
EXPORT_COMPRESSION "gz"
EXPORT_STRATEGY "truncate"
</sink_pipe_instructions>


<connection_file_instructions>
    - Content cannot be empty.
    - The connection names must be unique.
    - No indentation is allowed for property names
    - We support kafka, gcs and s3 connections for now
</connection_file_instructions>


<kafka_connection_content>
TYPE kafka
KAFKA_BOOTSTRAP_SERVERS {{ tb_secret("PRODUCTION_KAFKA_SERVERS", "localhost:9092") }}
KAFKA_SECURITY_PROTOCOL SASL_SSL
KAFKA_SASL_MECHANISM PLAIN
KAFKA_KEY {{ tb_secret("PRODUCTION_KAFKA_USERNAME", "") }}
KAFKA_SECRET {{ tb_secret("PRODUCTION_KAFKA_PASSWORD", "") }}
</kafka_connection_content>


<gcs_connection_content>
TYPE gcs
GCS_SERVICE_ACCOUNT_CREDENTIALS_JSON {{ tb_secret("PRODUCTION_GCS_SERVICE_ACCOUNT_CREDENTIALS_JSON", "") }}
</gcs_connection_content>


<gcs_hmac_connection_content>
TYPE gcs
GCS_HMAC_ACCESS_ID {{ tb_secret("gcs_hmac_access_id") }}
GCS_HMAC_SECRET {{ tb_secret("gcs_hmac_secret") }}
</gcs_hmac_connection_content>


<s3_connection_content>
TYPE s3
S3_REGION {{ tb_secret("PRODUCTION_S3_REGION", "") }}
S3_ARN {{ tb_secret("PRODUCTION_S3_ARN", "") }}
</s3_connection_content>


## .test file instructions
Follow these instructions when creating or updating .yaml files for tests:

- The test file name must match the name of the pipe it is testing.
- Every scenario name must be unique inside the test file.
- When looking for the parameters available, you will find them in the pipes in the following format: {{{{String(my_param_name, default_value)}}}}.
- If there are no parameters, you can omit parameters and generate a single test.
- The format of the parameters is the following: param1=value1&param2=value2&param3=value3
- If some parameters are provided by the user and you need to use them, preserve in the same format as they were provided, like case sensitive
- Test as many scenarios as possible.
- The format of the test file is the following:
<test_file_format>
- name: kpis_single_day
  description: Test hourly granularity for a single day
  parameters: date_from=2024-01-01&date_to=2024-01-01
  expected_result: |
    {"date":"2024-01-01 00:00:00","visits":0,"pageviews":0,"bounce_rate":null,"avg_session_sec":0}
    {"date":"2024-01-01 01:00:00","visits":0,"pageviews":0,"bounce_rate":null,"avg_session_sec":0}

- name: kpis_date_range
  description: Test daily granularity for a date range
  parameters: date_from=2024-01-01&date_to=2024-01-31
  expected_result: |
    {"date":"2024-01-01","visits":0,"pageviews":0,"bounce_rate":null,"avg_session_sec":0}
    {"date":"2024-01-02","visits":0,"pageviews":0,"bounce_rate":null,"avg_session_sec":0}

- name: kpis_default_range
  description: Test default behavior without date parameters (last 7 days)
  parameters: ''
  expected_result: |
    {"date":"2025-01-10","visits":0,"pageviews":0,"bounce_rate":null,"avg_session_sec":0}
    {"date":"2025-01-11","visits":0,"pageviews":0,"bounce_rate":null,"avg_session_sec":0}

- name: kpis_fixed_time
  description: Test with fixed timestamp for consistent testing
  parameters: fixed_time=2024-01-15T12:00:00
  expected_result: ''

- name: kpis_single_day
  description: Test single day with hourly granularity
  parameters: date_from=2024-01-01&date_to=2024-01-01
  expected_result: |
    {"date":"2024-01-01 00:00:00","visits":0,"pageviews":0,"bounce_rate":null,"avg_session_sec":0}
    {"date":"2024-01-01 01:00:00","visits":0,"pageviews":0,"bounce_rate":null,"avg_session_sec":0}

</test_file_format>


## Deployment instructions
Follow these instructions when evolving a datasource schema:

- When you make schema changes that are incompatible with the old schema, you must use a forward query in your data source. Forward queries are necessary when introducing breaking changes. Otherwise, your deployment will fail due to a schema mismatch.
- Forward queries translate the old schema to a new one that you define in the .datasource file. This helps you evolve your schema while continuing to ingest data.
Follow these steps to evolve your schema using a forward query:
- Edit the .datasource file to add a forward query.
- Run tb deploy --check to validate the deployment before creating it.
- Deploy and promote your changes in Tinybird Cloud using {base_command} --cloud deploy.
    <forward_query_example>
SCHEMA >
    `timestamp` DateTime `json:$.timestamp`,
    `session_id` UUID `json:$.session_id`,
    `action` String `json:$.action`,
    `version` String `json:$.version`,
    `payload` String `json:$.payload`

FORWARD_QUERY >
    select timestamp, toUUID(session_id) as session_id, action, version, payload
    </forward_query_example>
</deployment_instruction>

