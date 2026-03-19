# `@cap/web-backend`

Implementations for the backend services of `@cap/web`.

## Services

Code is organized horizontally by domain/entity (Video, Folder, stc),
and then in the following way where applicable:

- Repository Service (VideosRepo)
- Policy Service (VideosPolicy)
- Domain Service (Videos)

#### Repository Services

Wrap database queries for easier mocking and auditing.
These services should not be exported from the package,
as they do not handle access control.

#### Policy Services

Provide functions to determine if the CurrentUser has a given level
of access to a resource.

#### Domain Services

Provide high-level functions to perform resource operations,
consuming Repository Services for database access, Policy Services for access control,
and other Domain Services for other business logic ie. S3 operations.
Domain Services are safe to export and consume inside HTTP/RPC handlers.

## RPC

Some resources have RPC endpoint implementations as defined in `@cap/web-domain`.
In a lot of cases, endpoint implementations are thin wrappers around Domain Services.
Endpoint implementations should never directly use Repository Services or they may introduce security vulnerabilities.
