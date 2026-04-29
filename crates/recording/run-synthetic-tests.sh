#!/bin/bash
cargo run --package cap-recording --example synthetic-test-runner --features test-utils -- "$@"
