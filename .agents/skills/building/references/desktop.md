# Desktop worktrees

There are separate Tauri and GPUI Cargo workspaces and toolchains. Never assume one cache key or one native runtime verifies both.

`warm --session <id> --source <idle-checkout>` snapshots prepared native dependencies into the Git-common cache, then creates a private copy-on-write clone in the worktree. `--rust` also warms `target/debug` and `apps/desktop-gpui/target/debug`. It excludes profiles, user media, release artifacts, and arbitrary contents of `target`.

The helper requires matching setup script, lockfiles, and toolchain files, uses a cache lock, checks for open files in the source, and refuses to overwrite existing destinations. Compiled Rust snapshots also require matching source trees, local changes, and both workspaces' Cargo configuration, including ignored configuration files. Prepare matching build configuration before `--rust`; use the default native-dependency-only warm when source or configuration differs. macOS uses `cp -cR`; Linux requires a filesystem supporting `cp --reflink=always`. There is no silent full-copy fallback. On unsupported filesystems, use fresh builds with compiler caching or a deliberately provisioned build runner.

Only seed caches from a quiescent, owned checkout whose build processes have stopped. Open-file checks do not prevent an unrelated process from starting a new build; do not use a live shared developer checkout as an automatically refreshed cache source. Cache snapshots are immutable by convention. Setup, signing, formatting, and compiler writes happen in each worktree's private clone.

APFS clones initially share unchanged blocks but grow as builds diverge. Always run Cargo in the destination before using a warmed binary: the snapshot does not prove which environment flags or toolchain binary produced the original artifacts. Cargo may rebuild because of source paths, toolchain, flags, or changed workspace crates. Measure `df` before and after real parallel builds to assess physical growth; `du` totals do not prove unique APFS usage. Do not promise a zero-space worktree or automatic reuse of every Rust artifact.

The existing setup script supports opt-in `CAP_USE_SCCACHE=1`; evaluate it with the actual workload. Rust incremental compilation and sccache have compatibility constraints, and final executable linking is not cached. Never globally disable incremental compilation or rewrite another worktree's Cargo configuration to force caching.

Native runtime isolation is separate from build isolation. Cap has single-instance behavior, fixed frontend ports, device permissions, deep-link handlers, keychain credentials, and persisted application data. `run --native` acquires an exclusive machine-local lease; that lease coordinates this workflow only and does not establish an isolated app profile.

Use `run --native` and `check --native` for expensive Rust compilation as well. This queues native work across sessions instead of launching twenty large builds at once. Complete compile checks before holding the lease with a long-lived native runtime. Source editing and independent web work can continue while a native job waits.

For v1, prefer a dedicated native runner/OS user with synthetic recordings and test credentials. Before any local native launch, explicitly verify its app identifier, data directory, recording library, frontend port, authentication callback, and existing process ownership. Do not launch it against the user's normal Cap profile. Native profile provisioning and parallel local Tauri/GPUI launch are not automated by this helper.

Use the platform's actual Cap CLI to capture native demos. Linux Daytona evidence cannot close macOS ScreenCaptureKit, Windows capture, hardware GPU, microphone/camera, permissions, or updater gates. Retain a platform matrix in the PR and keep it draft when required native verification is missing.
