use std::{
    collections::BTreeMap,
    path::Path,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::api::{self, DriveHttp, FileInfo, with_token};
use crate::sidecar::{self, Sidecar};
use crate::types::{
    DriveError, DriveShare, Endpoints, FILE_MARKER, LinkVisibility, PrivateReason, Progress,
    SESSION_MAX_AGE, ShareFileRequest, TokenSource, UploadOptions, VIDEO_MIME,
};
use crate::upload::{
    self, FileMetadata, Session, SessionStatus, UploadFailure, UploadSource, now_ms, transient,
};

const MAX_RESTARTS: u32 = 2;

pub async fn share_file<T: TokenSource>(
    http: &DriveHttp,
    endpoints: &Endpoints,
    tokens: &T,
    request: ShareFileRequest<'_>,
    progress: &(dyn Fn(Progress) + Send + Sync),
    cancel: &AtomicBool,
) -> Result<DriveShare, DriveError> {
    let stat = std::fs::metadata(request.file).map_err(local_file)?;
    if !stat.is_file() {
        return Err(DriveError::LocalFile(format!(
            "{} is not a file",
            request.file.display()
        )));
    }
    let job = Job {
        http,
        endpoints,
        tokens,
        dir: request.sidecar_dir,
        file: request.file,
        total: stat.len(),
        options: &request.options,
        progress,
        cancel,
    };
    let modified_ms = stat.modified().ok().map_or(0, ms_since_epoch);
    let source = source_name(request.file, request.sidecar_dir);
    let mut state = starting_sidecar(
        request.sidecar_dir,
        &source,
        stat.len(),
        modified_ms,
        request.account_email,
    );
    let outcome = job.share(&mut state, &request).await;
    match &outcome {
        Ok(_) => state.last_error = None,
        Err(error) => state.last_error = Some(error.to_string()),
    }
    record(request.sidecar_dir, &state);
    outcome
}

fn local_file(error: std::io::Error) -> DriveError {
    DriveError::LocalFile(error.to_string())
}

fn ms_since_epoch(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

fn source_name(file: &Path, dir: &Path) -> String {
    file.strip_prefix(dir)
        .unwrap_or(file)
        .to_string_lossy()
        .into_owned()
}

fn starting_sidecar(
    dir: &Path,
    source: &str,
    size: u64,
    modified_ms: i64,
    account_email: Option<&str>,
) -> Sidecar {
    let fresh = Sidecar {
        version: sidecar::VERSION,
        source: source.to_string(),
        size,
        modified_ms,
        account_email: account_email.map(str::to_string),
        ..Sidecar::default()
    };
    match sidecar::load(dir) {
        Some(old) if old.account_email.as_deref() == account_email => {
            if sidecar::matches_source(&old, source, size, modified_ms) {
                old
            } else {
                Sidecar {
                    folder_id: old.folder_id,
                    ..fresh
                }
            }
        }
        _ => fresh,
    }
}

fn record(dir: &Path, state: &Sidecar) {
    let _ = sidecar::save(dir, state);
}

fn clear_session(state: &mut Sidecar) {
    state.session_uri = None;
    state.session_started_at_ms = None;
    state.offset = 0;
}

fn resumable_session(state: &Sidecar) -> Option<Session> {
    let uri = state.session_uri.clone()?;
    let started_at_ms = state.session_started_at_ms?;
    let age = u64::try_from(now_ms().saturating_sub(started_at_ms)).ok()?;
    (Duration::from_millis(age) < SESSION_MAX_AGE).then_some(Session { uri, started_at_ms })
}

fn backoff_delay(options: &UploadOptions, failure: u32) -> Duration {
    options
        .backoff_base
        .saturating_mul(2u32.saturating_pow(failure))
        .min(options.backoff_max)
}

enum Step {
    Start,
    Query(Session),
    Upload(Session, u64),
}

struct Job<'a, T> {
    http: &'a DriveHttp,
    endpoints: &'a Endpoints,
    tokens: &'a T,
    dir: &'a Path,
    file: &'a Path,
    total: u64,
    options: &'a UploadOptions,
    progress: &'a (dyn Fn(Progress) + Send + Sync),
    cancel: &'a AtomicBool,
}

impl<T: TokenSource> Job<'_, T> {
    async fn share(
        &self,
        state: &mut Sidecar,
        request: &ShareFileRequest<'_>,
    ) -> Result<DriveShare, DriveError> {
        if let Some(share) = self.reuse(state, request.known_folder_id).await? {
            return Ok(share);
        }
        let known_folder = state.folder_id.clone();
        let folder_id = api::ensure_folder(
            self.http,
            self.endpoints,
            self.tokens,
            request.folder_name,
            known_folder.as_deref().or(request.known_folder_id),
        )
        .await?;
        if known_folder.as_deref() != Some(folder_id.as_str()) {
            clear_session(state);
        }
        state.folder_id = Some(folder_id.clone());
        let meta = FileMetadata {
            name: request.name.to_string(),
            mime_type: VIDEO_MIME.to_string(),
            parents: vec![folder_id.clone()],
            description: request.description.map(str::to_string),
            app_properties: BTreeMap::from([(
                FILE_MARKER.0.to_string(),
                FILE_MARKER.1.to_string(),
            )]),
        };
        let info = self.transfer(state, &meta).await?;
        clear_session(state);
        state.offset = self.total;
        state.file_id = Some(info.id.clone());
        state.public = false;
        let link = match info.web_view_link {
            Some(link) => link,
            None => self.fetch_link(&info.id).await?,
        };
        state.web_view_link = Some(link.clone());
        record(self.dir, state);
        let visibility = self.publish(state, &info.id).await;
        Ok(DriveShare {
            file_id: info.id,
            web_view_link: link,
            folder_id,
            visibility,
            reused: false,
        })
    }

    async fn reuse(
        &self,
        state: &mut Sidecar,
        known_folder_id: Option<&str>,
    ) -> Result<Option<DriveShare>, DriveError> {
        let Some(file_id) = state.file_id.clone() else {
            return Ok(None);
        };
        let found = self.get_file(&file_id).await?;
        let link = match found {
            Some(info) if !info.trashed => state.web_view_link.clone().or(info.web_view_link),
            _ => None,
        };
        let Some(link) = link else {
            state.file_id = None;
            state.web_view_link = None;
            state.public = false;
            return Ok(None);
        };
        state.web_view_link = Some(link.clone());
        let visibility = if state.public {
            LinkVisibility::Public
        } else {
            self.publish(state, &file_id).await
        };
        Ok(Some(DriveShare {
            file_id,
            web_view_link: link,
            folder_id: state
                .folder_id
                .clone()
                .or_else(|| known_folder_id.map(str::to_string))
                .unwrap_or_default(),
            visibility,
            reused: true,
        }))
    }

    async fn get_file(&self, file_id: &str) -> Result<Option<FileInfo>, DriveError> {
        let (http, endpoints) = (self.http, self.endpoints);
        with_token(self.tokens, |token| async move {
            api::get_file(http, endpoints, &token, file_id).await
        })
        .await
    }

    async fn fetch_link(&self, file_id: &str) -> Result<String, DriveError> {
        self.get_file(file_id)
            .await?
            .and_then(|info| info.web_view_link)
            .ok_or_else(|| DriveError::Protocol("Google Drive returned no webViewLink".into()))
    }

    async fn publish(&self, state: &mut Sidecar, file_id: &str) -> LinkVisibility {
        let (http, endpoints) = (self.http, self.endpoints);
        let mut failures = 0;
        let visibility = loop {
            let answer = with_token(self.tokens, |token| async move {
                api::make_public(http, endpoints, &token, file_id).await
            })
            .await;
            match answer {
                Ok(visibility) => break visibility,
                Err(error) if transient(&error) => {
                    if let Err(error) = self.back_off(&mut failures, error).await {
                        break private_because(&error);
                    }
                }
                Err(error) => break private_because(&error),
            }
        };
        state.public = visibility == LinkVisibility::Public;
        visibility
    }

    async fn transfer(
        &self,
        state: &mut Sidecar,
        meta: &FileMetadata,
    ) -> Result<FileInfo, DriveError> {
        let mut step = resumable_session(state).map_or(Step::Start, Step::Query);
        let mut failures = 0;
        let mut restarts = 0;
        let mut confirmed = 0;
        loop {
            if self.cancel.load(Ordering::SeqCst) {
                return Err(DriveError::Cancelled);
            }
            step = match step {
                Step::Start => {
                    confirmed = 0;
                    let session = self.start(state, meta, &mut failures).await?;
                    Step::Upload(session, 0)
                }
                Step::Query(session) => {
                    match upload::query_status(self.http, &session, self.total).await {
                        Ok(SessionStatus::Received(offset)) => {
                            state.offset = offset;
                            advanced(&mut confirmed, &mut failures, offset);
                            Step::Upload(session, offset)
                        }
                        Ok(SessionStatus::Complete(info)) => return Ok(info),
                        Ok(SessionStatus::Gone) => {
                            clear_session(state);
                            Step::Start
                        }
                        Ok(SessionStatus::Rejected(error)) => {
                            restart(state, &mut restarts, error)?;
                            Step::Start
                        }
                        Err(error) if transient(&error) => {
                            self.back_off(&mut failures, error).await?;
                            Step::Query(session)
                        }
                        Err(error) => return Err(error),
                    }
                }
                Step::Upload(session, offset) => match self.send(state, &session, offset).await {
                    Ok(info) => return Ok(info),
                    Err(UploadFailure::Interrupted(error)) => {
                        advanced(&mut confirmed, &mut failures, state.offset);
                        self.back_off(&mut failures, error).await?;
                        Step::Query(session)
                    }
                    Err(UploadFailure::SessionGone) => {
                        restart(
                            state,
                            &mut restarts,
                            DriveError::Protocol(
                                "Google Drive dropped the upload session repeatedly".into(),
                            ),
                        )?;
                        Step::Start
                    }
                    Err(UploadFailure::Restart(error)) => {
                        restart(state, &mut restarts, error)?;
                        Step::Start
                    }
                    Err(UploadFailure::Fatal(error)) => return Err(error),
                },
            };
        }
    }

    async fn send(
        &self,
        state: &mut Sidecar,
        session: &Session,
        offset: u64,
    ) -> Result<FileInfo, UploadFailure> {
        let snapshot = state.clone();
        let reached = AtomicU64::new(offset);
        let dir = self.dir;
        let on_offset = |offset: u64| {
            reached.store(offset, Ordering::SeqCst);
            let mut saved = snapshot.clone();
            saved.offset = offset;
            record(dir, &saved);
        };
        let result = upload::upload_from(
            self.http,
            UploadSource {
                session,
                file: self.file,
                total: self.total,
            },
            offset,
            self.options,
            self.progress,
            self.cancel,
            &on_offset,
        )
        .await;
        state.offset = reached.load(Ordering::SeqCst);
        result
    }

    async fn start(
        &self,
        state: &mut Sidecar,
        meta: &FileMetadata,
        failures: &mut u32,
    ) -> Result<Session, DriveError> {
        let (http, endpoints, total) = (self.http, self.endpoints, self.total);
        loop {
            let started = with_token(self.tokens, |token| async move {
                upload::start_session(http, endpoints, &token, meta, total).await
            })
            .await;
            match started {
                Ok(session) => {
                    state.session_uri = Some(session.uri.clone());
                    state.session_started_at_ms = Some(session.started_at_ms);
                    state.offset = 0;
                    sidecar::save(self.dir, state).map_err(local_file)?;
                    return Ok(session);
                }
                Err(error) if transient(&error) => self.back_off(failures, error).await?,
                Err(error) => return Err(error),
            }
        }
    }

    async fn back_off(&self, failures: &mut u32, error: DriveError) -> Result<(), DriveError> {
        *failures += 1;
        if *failures >= self.options.max_attempts.max(1) {
            return Err(error);
        }
        let delay = backoff_delay(self.options, *failures - 1);
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        Ok(())
    }
}

fn advanced(confirmed: &mut u64, failures: &mut u32, offset: u64) {
    if offset > *confirmed {
        *confirmed = offset;
        *failures = 0;
    }
}

fn private_because(error: &DriveError) -> LinkVisibility {
    LinkVisibility::Private(PrivateReason::Other(error.to_string()))
}

fn restart(state: &mut Sidecar, restarts: &mut u32, error: DriveError) -> Result<(), DriveError> {
    *restarts += 1;
    if *restarts > MAX_RESTARTS {
        return Err(error);
    }
    clear_session(state);
    Ok(())
}
