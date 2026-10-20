# Cap's tauri-plugin-store patch

Source: the published `tauri-plugin-store` 2.4.0 crate, with its original
Rust sources, permission files, global JavaScript API, build script, and licenses.

Backports [upstream #3157](https://github.com/tauri-apps/plugins-workspace/pull/3157)
([commit eebfd2ed](https://github.com/tauri-apps/plugins-workspace/commit/eebfd2ed3e4bae4ef195f20c992f01657a5f5121)):
return the resource lookup error when a cached store ID no longer exists.
Tauri's `cleanup_before_exit` can clear the resource table without notifying
the store plugin. Unwrapping that lookup panics while holding the store registry
lock, poisoning subsequent accesses.

The first release with this fix, 2.4.2, requires Tauri 2.9.3. This backport keeps
Cap's locked Tauri 2.8.5 and its existing plugin API. It does not reload, replace,
or save a store after a failed resource lookup.

The standalone package manifest preserves the 2.4.0 runtime dependencies.
Its test dependencies use Tauri's mock runtime and temporary files. The package
is a workspace member so the lifecycle regression tests run against Cap's
lockfile in CI, without building the legacy desktop application's media stack.
The copied generated JavaScript bundle and permission schema are excluded from
Biome so they remain byte-for-byte identical to the upstream crate.

Run `cargo test --locked -p tauri-plugin-store --test store_lifecycle`.
The tests cover exit cleanup, repeated lookups after an invalid resource,
unchanged persisted settings, and normal close/reopen behavior.
