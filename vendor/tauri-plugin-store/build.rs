// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

const COMMANDS: &[&str] = &[
    "load",
    "get_store",
    "set",
    "get",
    "has",
    "delete",
    "clear",
    "reset",
    "keys",
    "values",
    "entries",
    "length",
    "reload",
    "save",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .global_api_script_path("./api-iife.js")
        .build();
}
