//! Chaos and resilience suite: hostile device data, files, projects and
//! settings through the engines, every probe in its own child process, so
//! panics, aborts, fatal signals, Objective-C exceptions and hangs are
//! classified instead of ending the run (see `chaos_support/harness.rs`).
//!
//! Outcomes: a clean error or a checked success passes; `panic`, `abort`,
//! `objc-exception`, `hang` and `wrong-success` (success reported for an
//! empty or unreadable output) are failures, judged against the strict
//! expected failures in `crates/verify/expectations.toml`.

mod chaos_support;
mod common;

use chaos_support::{all, harness};

#[test]
fn chaos_child() {
    harness::child_main(all);
}

#[test]
fn chaos_recording() {
    harness::run_group(all, "chaos/record/");
}

#[test]
fn chaos_files() {
    if std::env::var(harness::CHILD_ENV).is_err() {
        common::init();
        chaos_support::project::base().expect("base fixture");
    }
    harness::run_group(all, "chaos/files/");
}

#[test]
fn chaos_export() {
    if std::env::var(harness::CHILD_ENV).is_err() {
        common::init();
        chaos_support::project::base().expect("base fixture");
    }
    harness::run_group(all, "chaos/export/");
}

#[test]
fn chaos_fragments() {
    if std::env::var(harness::CHILD_ENV).is_err() {
        common::init();
        chaos_support::fragments::prepare_fixture().expect("fragment fixture");
    }
    harness::run_group(all, "chaos/fragments/");
}

#[test]
fn chaos_fuzz() {
    if std::env::var(harness::CHILD_ENV).is_err() {
        common::init();
        chaos_support::fragments::prepare_fixture().expect("fragment fixture");
        chaos_support::project::base().expect("base fixture");
    }
    harness::run_group(all, "chaos/fuzz/");
}

#[test]
fn chaos_editor() {
    if std::env::var(harness::CHILD_ENV).is_err() {
        common::init();
        chaos_support::project::base().expect("base fixture");
    }
    harness::run_group(all, "chaos/editor/");
}
