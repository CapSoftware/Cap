// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
    marker::PhantomData,
    path::{Path, PathBuf},
    sync::Arc,
};

use tauri::{ipc::ScopeObject, utils::acl::Value, AppHandle, Manager, Runtime};

use crate::{scope_entry::EntryRaw, Error};

pub use crate::scope_entry::Application;

#[derive(Debug)]
pub enum Entry {
    Url {
        url: glob::Pattern,
        app: Application,
    },
    Path {
        path: Option<PathBuf>,
        app: Application,
    },
}

impl ScopeObject for Entry {
    type Error = Error;

    fn deserialize<R: Runtime>(
        app_handle: &AppHandle<R>,
        raw: Value,
    ) -> std::result::Result<Self, Self::Error> {
        serde_json::from_value(raw.into())
            .and_then(|raw| {
                let entry = match raw {
                    EntryRaw::Url { url, app } => Entry::Url {
                        url: glob::Pattern::new(&url)
                            .map_err(|e| serde::de::Error::custom(e.to_string()))?,
                        app,
                    },
                    EntryRaw::Path { path, app } => {
                        let path = match app_handle.path().parse(path) {
                            Ok(path) => Some(path),
                            #[cfg(not(target_os = "android"))]
                            Err(tauri::Error::UnknownPath) => None,
                            Err(err) => return Err(serde::de::Error::custom(err.to_string())),
                        };

                        Entry::Path { path, app }
                    }
                };

                Ok(entry)
            })
            .map_err(Into::into)
    }
}

impl Application {
    fn matches(&self, a: Option<&str>) -> bool {
        match self {
            Self::Default => a.is_none(),
            Self::Enable(enable) => *enable,
            Self::App(program) => Some(program.as_str()) == a,
        }
    }
}

impl Entry {
    fn path(&self) -> Option<PathBuf> {
        match self {
            Self::Url { .. } => None,
            Self::Path { path, .. } => path.clone(),
        }
    }

    fn matches_url(&self, u: &str, a: Option<&str>) -> bool {
        match self {
            Self::Url { url, app } => url.matches(u) && app.matches(a),
            Self::Path { .. } => false,
        }
    }

    fn matches_path_program(&self, a: Option<&str>) -> bool {
        match self {
            Self::Url { .. } => false,
            Self::Path { app, .. } => app.matches(a),
        }
    }
}

#[derive(Debug)]
pub struct Scope<'a, R: Runtime, M: Manager<R>> {
    allowed: Vec<&'a Arc<Entry>>,
    denied: Vec<&'a Arc<Entry>>,
    manager: &'a M,
    _marker: PhantomData<R>,
}

impl<'a, R: Runtime, M: Manager<R>> Scope<'a, R, M> {
    pub(crate) fn new(
        manager: &'a M,
        allowed: Vec<&'a Arc<Entry>>,
        denied: Vec<&'a Arc<Entry>>,
    ) -> Self {
        Self {
            manager,
            allowed,
            denied,
            _marker: PhantomData,
        }
    }

    pub fn is_url_allowed(&self, url: &str, with: Option<&str>) -> bool {
        let denied = self.denied.iter().any(|e| e.matches_url(url, with));
        if denied {
            false
        } else {
            self.allowed.iter().any(|e| e.matches_url(url, with))
        }
    }

    pub fn is_path_allowed(&self, path: &Path, with: Option<&str>) -> crate::Result<bool> {
        let fs_scope = tauri::fs::Scope::new(
            self.manager,
            &tauri::utils::config::FsScope::Scope {
                allow: self.allowed.iter().filter_map(|e| e.path()).collect(),
                deny: self.denied.iter().filter_map(|e| e.path()).collect(),
                require_literal_leading_dot: self
                    .manager
                    .state::<crate::Opener<R>>()
                    .require_literal_leading_dot,
            },
        )?;

        Ok(fs_scope.is_allowed(path) && self.allowed.iter().any(|e| e.matches_path_program(with)))
    }
}
