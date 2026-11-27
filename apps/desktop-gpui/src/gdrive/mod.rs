pub(crate) mod account;
pub(crate) mod instant;
#[cfg(all(test, target_os = "macos"))]
mod real_app_tests;
#[cfg(test)]
mod tests;

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError, atomic::AtomicBool},
};

pub(crate) use cap_gdrive::{DriveError, DriveShare, LinkVisibility, PrivateReason};

use crate::i18n::tr;
use crate::store::{GENERAL_SETTINGS, set_store_setting, store_section};

pub(crate) const PROVIDER_KEY: &str = "shareLinkProvider";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ShareProvider {
    #[default]
    Cap,
    GoogleDrive,
}

impl ShareProvider {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Cap => "cap",
            Self::GoogleDrive => "googleDrive",
        }
    }

    pub(crate) fn parse(value: Option<&str>) -> Self {
        match value {
            Some("googleDrive") => Self::GoogleDrive,
            _ => Self::Cap,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LinkRoute {
    Cap,
    SignInToCap,
    Drive,
    ConnectDrive,
}

pub(crate) fn share_provider() -> ShareProvider {
    ShareProvider::parse(
        store_section(GENERAL_SETTINGS)
            .get(PROVIDER_KEY)
            .and_then(serde_json::Value::as_str),
    )
}

pub(crate) fn set_share_provider(provider: ShareProvider) -> bool {
    set_store_setting(
        GENERAL_SETTINGS,
        PROVIDER_KEY,
        serde_json::Value::String(provider.as_str().into()),
    )
}

pub(crate) fn drive_ready() -> bool {
    share_provider() == ShareProvider::GoogleDrive
        && matches!(
            account::status(&account::default_dir()),
            account::DriveStatus::Connected { .. }
        )
}

pub(crate) fn link_route(
    provider: ShareProvider,
    drive_ready: bool,
    cap_signed_in: bool,
) -> LinkRoute {
    match (provider, drive_ready, cap_signed_in) {
        (ShareProvider::Cap, _, true) => LinkRoute::Cap,
        (ShareProvider::Cap, _, false) => LinkRoute::SignInToCap,
        (ShareProvider::GoogleDrive, true, _) => LinkRoute::Drive,
        (ShareProvider::GoogleDrive, false, _) => LinkRoute::ConnectDrive,
    }
}

pub(crate) fn current_link_route() -> LinkRoute {
    link_route(
        share_provider(),
        drive_ready(),
        crate::store::auth_snapshot().signed_in(),
    )
}

pub(crate) fn is_drive_sharing(sharing: &cap_project::SharingMeta) -> bool {
    cap_gdrive::is_drive_sharing_id(&sharing.id)
}

pub(crate) fn current_sharing(
    sharing: Option<&cap_project::SharingMeta>,
    provider: ShareProvider,
) -> Option<&cap_project::SharingMeta> {
    sharing.filter(|sharing| is_drive_sharing(sharing) == (provider == ShareProvider::GoogleDrive))
}

pub(crate) fn sharing_meta(share: &DriveShare) -> cap_project::SharingMeta {
    cap_project::SharingMeta {
        id: cap_gdrive::sharing_id(&share.file_id),
        link: share.web_view_link.clone(),
        content_hash: None,
    }
}

pub(crate) struct ShareRequest {
    pub project_dir: PathBuf,
    pub file: PathBuf,
    pub title: String,
    pub progress: Arc<dyn Fn(f64) + Send + Sync>,
    pub cancel: Arc<AtomicBool>,
}

#[derive(Debug, PartialEq)]
pub(crate) enum ShareFailure {
    AlreadyUploading,
    Drive(DriveError),
}

impl From<DriveError> for ShareFailure {
    fn from(error: DriveError) -> Self {
        Self::Drive(error)
    }
}

static SHARING: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Mutex::default);

fn sharing_set() -> MutexGuard<'static, HashSet<PathBuf>> {
    SHARING.lock().unwrap_or_else(PoisonError::into_inner)
}

struct ShareSlot {
    canonical: PathBuf,
    keys: Vec<PathBuf>,
}

impl ShareSlot {
    fn claim(project_dir: &Path) -> Option<Self> {
        let canonical = project_dir
            .canonicalize()
            .unwrap_or_else(|_| project_dir.to_path_buf());
        let mut sharing = sharing_set();
        if sharing.contains(&canonical) {
            return None;
        }
        let mut keys = vec![project_dir.to_path_buf()];
        if canonical != project_dir {
            keys.push(canonical.clone());
        }
        sharing.extend(keys.iter().cloned());
        Some(Self { canonical, keys })
    }

    fn remember(&self, visibility: &LinkVisibility) {
        let mut private = private_links();
        if matches!(visibility, LinkVisibility::Private(_)) {
            private
                .entry(self.canonical.clone())
                .or_default()
                .extend(self.keys.iter().cloned());
        } else {
            private.remove(&self.canonical);
        }
    }
}

impl Drop for ShareSlot {
    fn drop(&mut self) {
        let mut sharing = sharing_set();
        for key in &self.keys {
            sharing.remove(key);
        }
    }
}

pub(crate) fn share_in_flight(project_dir: &Path) -> bool {
    sharing_set().contains(project_dir)
}

static PRIVATE_LINKS: LazyLock<Mutex<HashMap<PathBuf, HashSet<PathBuf>>>> =
    LazyLock::new(Mutex::default);

fn private_links() -> MutexGuard<'static, HashMap<PathBuf, HashSet<PathBuf>>> {
    PRIVATE_LINKS.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn drive_link_private(project_dir: &Path) -> bool {
    private_links()
        .values()
        .any(|names| names.contains(project_dir))
}

pub(crate) async fn share_recording(request: ShareRequest) -> Result<DriveShare, ShareFailure> {
    let Some(slot) = ShareSlot::claim(&request.project_dir) else {
        return Err(ShareFailure::AlreadyUploading);
    };
    let project_dir = request.project_dir.clone();
    let share = share_recording_in(&account::default_dir(), &account::endpoints(), request).await?;
    slot.remember(&share.visibility);
    crate::automation::upload_completed(
        &project_dir,
        None,
        Some((share.web_view_link.clone(), sharing_meta(&share).id)),
    );
    Ok(share)
}

pub(crate) fn recording_title(project_dir: &Path) -> String {
    cap_project::RecordingMeta::load_for_project(project_dir)
        .ok()
        .map(|meta| meta.pretty_name)
        .filter(|title| !title.trim().is_empty())
        .or_else(|| {
            project_dir
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .filter(|stem| !stem.trim().is_empty())
        })
        .unwrap_or_else(|| tr::gdrive::untitled_recording().into())
}

pub(crate) fn share_failure_message(failure: &ShareFailure) -> String {
    match failure {
        ShareFailure::AlreadyUploading => tr::gdrive::already_uploading().into(),
        ShareFailure::Drive(error) => upload_error_message(error),
    }
}

async fn share_recording_in(
    dir: &Path,
    endpoints: &cap_gdrive::Endpoints,
    request: ShareRequest,
) -> Result<DriveShare, DriveError> {
    let stored = account::load(dir);
    if account::pick_client(stored.client.as_ref()).is_none() {
        return Err(DriveError::NotConfigured);
    }
    let Some(signed_in) = stored.account.as_ref() else {
        return Err(DriveError::NotConnected);
    };
    let tokens = account::AccountTokens::new(dir.to_path_buf(), endpoints.clone())?;
    let http = cap_gdrive::api::DriveHttp::new()?;
    let name = format!("{}.mp4", request.title);
    let progress = request.progress.clone();
    let report = move |sent: cap_gdrive::Progress| progress(sent.fraction());
    let share = cap_gdrive::share_file(
        &http,
        endpoints,
        &tokens,
        cap_gdrive::ShareFileRequest {
            file: &request.file,
            sidecar_dir: &request.project_dir,
            name: &name,
            description: None,
            folder_name: &stored.folder.name,
            known_folder_id: stored.folder.id.as_deref(),
            account_email: signed_in.email.as_deref(),
            options: cap_gdrive::UploadOptions::default(),
        },
        &report,
        &request.cancel,
    )
    .await?;
    if stored.folder.id.as_deref() != Some(share.folder_id.as_str()) {
        let folder = account::StoredFolder {
            name: stored.folder.name.clone(),
            id: Some(share.folder_id.clone()),
        };
        if let Err(error) = account::save_folder(dir, &folder) {
            tracing::warn!(%error, "could not save the Google Drive folder");
        }
    }
    if let Err(error) = write_sharing(&request.project_dir, &share) {
        tracing::warn!(
            dir = %request.project_dir.display(),
            %error,
            "could not save the Google Drive link with the recording"
        );
    }
    Ok(share)
}

fn write_sharing(project_dir: &Path, share: &DriveShare) -> Result<(), DriveError> {
    let mut meta = cap_project::RecordingMeta::load_for_project(project_dir)
        .map_err(|error| DriveError::LocalFile(error.to_string()))?;
    meta.sharing = Some(sharing_meta(share));
    meta.save_for_project()
        .map_err(|error| DriveError::LocalFile(error.to_string()))
}

pub(crate) fn error_message(error: &DriveError) -> String {
    match error {
        DriveError::Offline => tr::gdrive::error_offline().into(),
        DriveError::SignInAgain => tr::gdrive::error_reconnect().into(),
        DriveError::AdminBlocked => tr::gdrive::error_admin().into(),
        DriveError::StorageFull => tr::gdrive::error_full().into(),
        DriveError::RateLimited => tr::gdrive::error_busy().into(),
        DriveError::ApiDisabled => tr::gdrive::error_api_disabled().into(),
        DriveError::LocalFile(_) => tr::gdrive::error_missing_file().into(),
        DriveError::NotConnected | DriveError::NotConfigured => {
            tr::gdrive::error_not_connected().into()
        }
        DriveError::Denied => tr::gdrive::error_denied().into(),
        DriveError::Cancelled => String::new(),
        DriveError::Server { .. } | DriveError::Protocol(_) => tr::gdrive::error_other(error),
    }
}

pub(crate) fn upload_error_message(error: &DriveError) -> String {
    match error {
        DriveError::Cancelled => String::new(),
        DriveError::LocalFile(_) => error_message(error),
        _ => format!("{} {}", error_message(error), tr::gdrive::kept_locally()),
    }
}

pub(crate) fn private_link_message(reason: &PrivateReason) -> String {
    match reason {
        PrivateReason::RateLimited => tr::gdrive::private_link_busy().into(),
        PrivateReason::SharingRestricted | PrivateReason::Other(_) => {
            tr::gdrive::private_link().into()
        }
    }
}

#[cfg(test)]
mod facade_tests {
    use super::*;

    fn request(project: &Path) -> ShareRequest {
        ShareRequest {
            project_dir: project.to_path_buf(),
            file: project.join("content/output.mp4"),
            title: "Demo".into(),
            progress: Arc::new(|_| {}),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    #[cfg(unix)]
    #[test]
    fn one_folder_has_one_share_at_a_time_whatever_path_names_it() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("Demo.cap");
        std::fs::create_dir_all(&project).unwrap();
        let alias = root.path().join("Alias.cap");
        std::os::unix::fs::symlink(&project, &alias).unwrap();

        assert!(!share_in_flight(&project));
        let first = ShareSlot::claim(&alias).expect("the first share runs");
        assert!(share_in_flight(&alias));
        assert!(ShareSlot::claim(&alias).is_none());
        assert!(ShareSlot::claim(&project).is_none());
        drop(first);
        assert!(!share_in_flight(&alias));
        assert!(!share_in_flight(&project.canonicalize().unwrap()));
        let again = ShareSlot::claim(&project).expect("free again once the first ends");
        assert!(share_in_flight(&project));
        drop(again);
        assert!(!share_in_flight(&project));
    }

    #[cfg(unix)]
    #[test]
    fn a_private_link_is_remembered_under_every_name_of_the_folder() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("Demo.cap");
        std::fs::create_dir_all(&project).unwrap();
        let alias = root.path().join("Alias.cap");
        std::os::unix::fs::symlink(&project, &alias).unwrap();

        assert!(!drive_link_private(&project));
        let slot = ShareSlot::claim(&alias).unwrap();
        slot.remember(&LinkVisibility::Private(PrivateReason::RateLimited));
        drop(slot);
        assert!(drive_link_private(&alias));
        assert!(drive_link_private(&project.canonicalize().unwrap()));
        let slot = ShareSlot::claim(&project).unwrap();
        slot.remember(&LinkVisibility::Public);
        drop(slot);
        assert!(!drive_link_private(&alias));
        assert!(!drive_link_private(&project.canonicalize().unwrap()));
    }

    #[test]
    fn a_drive_file_is_never_named_with_an_empty_title() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("Monday standup.cap");
        std::fs::create_dir_all(&project).unwrap();
        assert_eq!(recording_title(&project), "Monday standup");
        assert_eq!(
            recording_title(Path::new("/")),
            tr::gdrive::untitled_recording()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_second_share_says_the_recording_is_already_uploading() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("Demo.cap");
        std::fs::create_dir_all(&project).unwrap();
        let running = ShareSlot::claim(&project).unwrap();
        let second = share_recording(request(&project)).await;
        assert_eq!(second, Err(ShareFailure::AlreadyUploading));
        assert_eq!(
            share_failure_message(&ShareFailure::AlreadyUploading),
            tr::gdrive::already_uploading()
        );
        drop(running);
        assert_eq!(
            share_failure_message(&ShareFailure::Drive(DriveError::Offline)),
            upload_error_message(&DriveError::Offline)
        );
        assert_eq!(
            ShareFailure::from(DriveError::Cancelled),
            ShareFailure::Drive(DriveError::Cancelled)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_link_is_returned_when_it_cannot_be_saved_with_the_recording() {
        let fake = cap_gdrive::fake::FakeGoogle::start();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(account::DIR);
        account::save_client(&dir, "drive-id", Some("drive-secret")).unwrap();
        fake.issue_code("code", "refresh-1", cap_gdrive::DRIVE_FILE_SCOPE);
        account::save_account(
            &dir,
            &account::StoredAccount {
                email: Some("me@example.com".into()),
                refresh_token: "refresh-1".into(),
                scope: cap_gdrive::DRIVE_FILE_SCOPE.into(),
                connected_at_ms: 1,
            },
        )
        .unwrap();
        let project = root.path().join("Demo.cap");
        std::fs::create_dir_all(project.join("content")).unwrap();
        std::fs::write(project.join("content/output.mp4"), vec![7u8; 4096]).unwrap();

        let share = share_recording_in(&dir, &fake.endpoints(), request(&project))
            .await
            .expect("the upload worked, so the link comes back");
        assert!(fake.files().iter().any(|file| file.id == share.file_id));
        assert!(cap_project::RecordingMeta::load_for_project(&project).is_err());
    }
}
