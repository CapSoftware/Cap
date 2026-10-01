# Cap changes to tauri-plugin-opener

Vendored from the crates.io `tauri-plugin-opener` 2.5.0 archive, SHA-256
`786156aa8e89e03d271fbd3fe642207da8e65f3c961baa9e2930f332bf80a1f5`.
The archive identifies upstream commit
`2371804172fa852ef3c127b2398c54bc35f74950` in
[tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace/tree/2371804172fa852ef3c127b2398c54bc35f74950/plugins/opener).

The async `reveal_item_in_dir` IPC command previously called the synchronous
reveal implementation on a Tokio worker. On Linux, blocking zbus can enter
its own Tokio runtime and panic. The command now awaits a blocking worker
and propagates both backend errors and worker failures. Its name, arguments,
permission definitions, path canonicalization, and native backends are unchanged.
All existing JavaScript callers retain the same IPC and permission boundary.

Tests cover both Tokio runtime flavors, exact path forwarding, backend errors,
worker panics, validation of all paths, and the real Linux zbus backend with the
Tokio feature enabled. The Linux test permits a missing session bus or file
manager; it does not establish successful graphical file selection.

The workspace uses this source through `[patch.crates-io]`. The crate is also a
workspace member so Cargo can run its regression tests. Dev dependencies reuse
versions already in the workspace lockfile. No runtime dependency was upgraded.

Packaging omits the upstream lockfile, original workspace manifest, npm build
configuration, and guest TypeScript sources. The shipped JavaScript bundles are
retained with formatting only. One trailing space in the Android build file is
removed. Rust source is rustfmt-formatted, and
the build regenerates the ignored permission schema. Both upstream licenses and
all platform source files are retained.

Current upstream still has the direct synchronous command call. Revisit this
patch when upstream supplies an equivalent async boundary and retain the tests.
