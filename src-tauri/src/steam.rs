use std::path::Path;
use std::sync::Mutex;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use steamworks::{
    AppIDs, AppId, Client, FileType, PublishedFileId, PublishedFileVisibility, SteamAPIInitError, SteamError,
    UGCStatisticType, UGCType, UpdateStatus, UserList, UserListOrder,
};
use winreg::RegKey;
use winreg::enums::HKEY_CURRENT_USER;

/// DayZ's app id. DayZ Publisher initialises Steam as DayZ too, which is what lets it publish to DayZ's Workshop.
pub const DAYZ: AppId = AppId(221100);
/// Steam returns at most this many items per page.
const PAGE_SIZE: u32 = 50;
/// How often to let Steam deliver results.
const CALLBACK_INTERVAL: Duration = Duration::from_millis(50);
/// How long to wait for Steam to answer anything other than an upload.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// How often to report an upload's progress.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// Gives up on an upload that hasn't finished after this long.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(4 * 60 * 60);
/// Disconnects from Steam after this long without a request, so Steam stops showing DayZ as running.
const IDLE_DISCONNECT: Duration = Duration::from_secs(90);
/// How often a wait on Steam checks it's still running and signed in.
const ALIVE_INTERVAL: Duration = Duration::from_secs(1);
/// Steam's limits. The steamworks crate panics if Steam rejects a value, so they're checked first.
/// Steam gives text limits as buffer sizes that include the terminating null (129 for a 128-byte
/// title), so each is a byte less than Steam's figure.
const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;
const MAX_TITLE_BYTES: usize = 128;
const MAX_DESCRIPTION_BYTES: usize = 7999;
const MAX_CHANGE_NOTE_BYTES: usize = 7999;
const MAX_TAG_LIST_BYTES: usize = 1024;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Visibility {
    Public,
    FriendsOnly,
    Unlisted,
    Private,
}

impl From<PublishedFileVisibility> for Visibility {
    fn from(value: PublishedFileVisibility) -> Self {
        match value {
            PublishedFileVisibility::Public => Self::Public,
            PublishedFileVisibility::FriendsOnly => Self::FriendsOnly,
            PublishedFileVisibility::Unlisted => Self::Unlisted,
            PublishedFileVisibility::Private => Self::Private,
        }
    }
}

impl From<Visibility> for PublishedFileVisibility {
    fn from(value: Visibility) -> Self {
        match value {
            Visibility::Public => Self::Public,
            Visibility::FriendsOnly => Self::FriendsOnly,
            Visibility::Unlisted => Self::Unlisted,
            Visibility::Private => Self::Private,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum SteamStatus {
    #[serde(rename_all = "camelCase")]
    Ready {
        user_name: String,
        steam_id: String,
    },
    Unavailable {
        message: String,
    },
}

/// Whether the Steam client is up, as far as it can be told without connecting to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SteamPresence {
    NotRunning,
    /// Running, but at the sign-in window or between accounts.
    SignedOut,
    SignedIn,
}

/// Where the Steam client records its process and signed-in account while it runs.
const ACTIVE_PROCESS_KEY: &str = r"Software\Valve\Steam\ActiveProcess";

/// Reads what Steam writes to the registry. Unlike connecting, this doesn't make Steam show the user as playing DayZ.
fn read_presence() -> SteamPresence {
    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(ACTIVE_PROCESS_KEY) else {
        return SteamPresence::NotRunning;
    };
    // Steam clears the pid when it exits, but not if it crashes, so check the process is still there.
    let pid: u32 = key.get_value("pid").unwrap_or(0);
    if pid == 0 || !process_running(pid) {
        return SteamPresence::NotRunning;
    }
    let user: u32 = key.get_value("ActiveUser").unwrap_or(0);
    if user == 0 { SteamPresence::SignedOut } else { SteamPresence::SignedIn }
}

pub(crate) fn process_running(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    // SAFETY: the handle is checked before use and closed once read.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // A process we aren't allowed to look at still exists.
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code = 0u32;
        let read = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        read && code == STILL_ACTIVE as u32
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkshopItem {
    /// Sent as a string because JavaScript numbers can't hold every u64.
    pub id: String,
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub visibility: Visibility,
    pub preview_url: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub time_created: u64,
    pub time_updated: u64,
    pub file_size: u64,
    pub stats: ItemStats,
    pub content_path: Option<String>,
    /// Earlier totals this app has recorded, oldest first.
    pub history: Vec<crate::store::StatSnapshot>,
}

/// Steam's running totals for an item. Lifetime figures, refreshed by Steam every few hours.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ItemStats {
    pub subscriptions: u64,
    pub unique_subscriptions: u64,
    pub favorites: u64,
    pub followers: u64,
    pub unique_website_views: u64,
    pub comments: u64,
    pub upvotes: u64,
    pub downvotes: u64,
    pub seconds_played: u64,
    pub playtime_sessions: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRequest {
    /// None creates a new item.
    pub item_id: Option<String>,
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub visibility: Visibility,
    pub preview_path: Option<String>,
    /// Sends the app's default preview image when `preview_path` is None, for a new item the modder hasn't chosen
    /// one for. Steam would otherwise show it with a blank picture.
    #[serde(default)]
    pub default_preview: bool,
    pub content_path: Option<String>,
    pub change_note: String,
    /// False sends only the files and change note, leaving the page as it is on Steam, which may have
    /// changed since the app loaded it. A new item always sends its page.
    pub send_page: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PublishStage {
    Creating,
    Preparing,
    UploadingContent,
    UploadingPreview,
    Committing,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishProgress {
    pub item_id: Option<String>,
    pub stage: PublishStage,
    pub processed: u64,
    pub total: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutcome {
    pub item_id: String,
    pub needs_agreement: bool,
}

/// Why publishing failed, with the item it created first if it got that far, so that trying again
/// finishes that item rather than creating another.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishError {
    pub message: String,
    pub item_id: Option<String>,
}

impl From<String> for PublishError {
    fn from(message: String) -> Self {
        Self { message, item_id: None }
    }
}

impl From<&str> for PublishError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

struct Connection {
    client: Client,
    /// Requests in progress. The connection isn't dropped while any are running.
    active: usize,
    last_used: Instant,
}

/// Holds the connection to the Steam client. It's made when needed and dropped when idle, because
/// while it's open Steam shows the user as playing DayZ.
pub struct Steam {
    connection: Mutex<Option<Connection>>,
}

/// One per app: the Steam API can only be initialised once at a time.
pub static STEAM: Steam = Steam { connection: Mutex::new(None) };

/// Keeps the connection open while a request runs.
struct Session<'a> {
    steam: &'a Steam,
    client: Client,
}

impl Drop for Session<'_> {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.steam.connection.lock()
            && let Some(connection) = slot.as_mut()
        {
            connection.active = connection.active.saturating_sub(1);
            connection.last_used = Instant::now();
        }
    }
}

fn init_error(error: SteamAPIInitError) -> String {
    match error {
        SteamAPIInitError::NoSteamClient(_) => "Steam isn't running. Start Steam and sign in, then try again.".into(),
        SteamAPIInitError::VersionMismatch(_) => {
            "Steam needs updating. Restart Steam to update it, then try again.".into()
        }
        SteamAPIInitError::FailedGeneric(message) if message.trim().is_empty() => {
            "Steam wouldn't connect. Make sure you're signed in to an account that owns DayZ.".into()
        }
        SteamAPIInitError::FailedGeneric(message) => format!("Steam wouldn't connect: {message}"),
    }
}

fn steam_error(error: SteamError) -> String {
    match error {
        SteamError::AccessDenied => {
            "Steam refused. Check that this account owns DayZ and that you own the item you're updating.".into()
        }
        SteamError::FileNotFound => "Steam couldn't find the item, or a file it was given.".into(),
        SteamError::LimitExceeded => {
            "That's over a Steam limit: the preview may be over 1 MB, or your Steam Cloud quota is full.".into()
        }
        SteamError::NotLoggedOn => "Steam is offline. Sign in to Steam and try again.".into(),
        SteamError::Timeout | SteamError::IOFailure => {
            "Steam didn't respond. Check your connection and try again.".into()
        }
        SteamError::Busy | SteamError::RateLimitExceeded => "Steam is busy. Wait a minute and try again.".into(),
        SteamError::InvalidParameter => "Steam rejected one of the values. Check the title, tags and files.".into(),
        other => format!("Steam returned an error: {other}."),
    }
}

/// Notices Steam closing or signing out during a wait. Its answer would never come then, so the wait
/// ends instead of running on to its timeout.
struct AliveCheck {
    last: Instant,
    /// Readings in a row that found Steam gone. It takes two, so a moment's blip doesn't end an upload.
    misses: u8,
}

impl AliveCheck {
    fn new() -> Self {
        Self { last: Instant::now(), misses: 0 }
    }

    fn check(&mut self) -> Result<(), String> {
        if self.last.elapsed() < ALIVE_INTERVAL {
            return Ok(());
        }
        self.last = Instant::now();
        match read_presence() {
            SteamPresence::SignedIn => self.misses = 0,
            _ if self.misses == 0 => self.misses = 1,
            SteamPresence::SignedOut => {
                return Err("Steam signed out before it finished. Sign in and try again.".into());
            }
            SteamPresence::NotRunning => {
                return Err("Steam closed before it finished. Start Steam and try again.".into());
            }
        }
        Ok(())
    }
}

/// Waits for a Steam call result, which arrives on the callback thread.
fn wait<T: Send + 'static>(start: impl FnOnce(Sender<T>)) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    start(tx);
    let started = Instant::now();
    let mut alive = AliveCheck::new();
    loop {
        match rx.recv_timeout(ALIVE_INTERVAL) {
            Ok(result) => return Ok(result),
            Err(RecvTimeoutError::Timeout) if started.elapsed() < REQUEST_TIMEOUT => alive.check()?,
            Err(_) => return Err("Steam didn't respond in time. Try again.".into()),
        }
    }
}

fn parse_id(id: &str) -> Result<PublishedFileId, String> {
    id.parse::<u64>().map(PublishedFileId).map_err(|_| format!("{id} isn't a Workshop item id."))
}

/// The preview image a new item gets when the modder hasn't chosen one. The frontend shows the same file.
const DEFAULT_PREVIEW: &[u8] = include_bytes!("../../src/assets/default-preview.png");
const _: () = assert!(DEFAULT_PREVIEW.len() as u64 <= MAX_PREVIEW_BYTES, "the default preview is over Steam's limit");

/// Writes the default preview image out for Steam, which only uploads a preview from a file.
fn default_preview() -> Result<std::path::PathBuf, String> {
    let path = std::env::temp_dir().join("flare-tools-default-preview.png");
    std::fs::write(&path, DEFAULT_PREVIEW).map_err(|e| format!("Couldn't prepare the default preview image: {e}"))?;
    std::fs::canonicalize(&path).map_err(|e| format!("Couldn't prepare the default preview image: {e}"))
}

/// Checks a value the steamworks crate would otherwise panic on.
fn check_text(label: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.contains('\0') {
        return Err(format!("The {label} contains a null character."));
    }
    if value.len() > max_bytes {
        return Err(format!("The {label} is too long: Steam allows {max_bytes} bytes and it's {}.", value.len()));
    }
    Ok(())
}

impl Steam {
    /// Starts a request, connecting to Steam first if needed.
    fn session(&'static self) -> Result<Session<'static>, String> {
        let mut slot = self.connection.lock().map_err(|_| "Steam is locked.".to_string())?;
        if slot.is_none() {
            let client = Client::init_app(DAYZ).map_err(init_error)?;
            *slot = Some(Connection { client, active: 0, last_used: Instant::now() });
            // Results only arrive while callbacks run, so run them until the connection goes idle.
            thread::spawn(move || {
                loop {
                    thread::sleep(CALLBACK_INTERVAL);
                    let Ok(mut slot) = self.connection.lock() else { break };
                    let Some(connection) = slot.as_ref() else { break };
                    if connection.active == 0 && connection.last_used.elapsed() > IDLE_DISCONNECT {
                        // Dropping the last client shuts the Steam API down.
                        slot.take();
                        break;
                    }
                    connection.client.run_callbacks();
                }
            });
        }
        let connection = slot.as_mut().expect("connected above");
        connection.active += 1;
        Ok(Session { steam: self, client: connection.client.clone() })
    }

    /// Checks Steam is still up. When it isn't, an idle connection is dropped, since it can't work again and the next
    /// request should reconnect and say why it can't, rather than time out on the old one.
    pub fn presence(&'static self) -> SteamPresence {
        let presence = read_presence();
        if presence != SteamPresence::SignedIn
            // Skipped while connecting, rather than waiting; the next check catches it.
            && let Ok(mut slot) = self.connection.try_lock()
            && slot.as_ref().is_some_and(|connection| connection.active == 0)
        {
            slot.take();
        }
        presence
    }

    pub fn status(&'static self) -> SteamStatus {
        match self.session() {
            Ok(Session { ref client, .. }) => SteamStatus::Ready {
                user_name: client.friends().name(),
                steam_id: client.user().steam_id().raw().to_string(),
            },
            Err(message) => SteamStatus::Unavailable { message },
        }
    }

    /// Deletes an item from the Workshop for good, along with its files.
    pub fn delete(&'static self, id: &str) -> Result<(), String> {
        let id = parse_id(id)?;
        let session = self.session()?;
        let ugc = session.client.ugc();
        wait(|tx| {
            ugc.delete_item(id, move |result| {
                let _ = tx.send(result);
            })
        })?
        .map_err(steam_error)
    }

    /// Lists the DayZ Workshop items the signed-in user has published, newest update first.
    pub fn items(&'static self) -> Result<Vec<WorkshopItem>, String> {
        let session = self.session()?;
        let client = &session.client;
        let account = client.user().steam_id().account_id();
        let mut items = Vec::new();
        for page in 1.. {
            let query = client
                .ugc()
                .query_user(
                    account,
                    UserList::Published,
                    UGCType::Items,
                    UserListOrder::LastUpdatedDesc,
                    AppIDs::ConsumerAppId(DAYZ),
                    page,
                )
                .map_err(|e| e.to_string())?
                .set_return_long_description(true);
            let (batch, total) = wait(|tx| {
                query.fetch(move |result| {
                    let _ = tx.send(result.map(|results| {
                        let batch: Vec<WorkshopItem> = results
                            .iter()
                            .enumerate()
                            .filter_map(|(i, item)| {
                                let item = item?;
                                let i = i as u32;
                                Some(WorkshopItem {
                                    id: item.published_file_id.0.to_string(),
                                    title: item.title,
                                    description: item.description,
                                    tags: item.tags.into_iter().filter(|t| !t.trim().is_empty()).collect(),
                                    visibility: item.visibility.into(),
                                    preview_url: results.preview_url(i).filter(|u| !u.is_empty()),
                                    time_created: u64::from(item.time_created) * 1000,
                                    time_updated: u64::from(item.time_updated) * 1000,
                                    file_size: u64::from(item.file_size),
                                    stats: {
                                        let stat = |kind| results.statistic(i, kind).unwrap_or(0);
                                        ItemStats {
                                            subscriptions: stat(UGCStatisticType::Subscriptions),
                                            unique_subscriptions: stat(UGCStatisticType::UniqueSubscriptions),
                                            favorites: stat(UGCStatisticType::Favorites),
                                            followers: stat(UGCStatisticType::Followers),
                                            unique_website_views: stat(UGCStatisticType::UniqueWebsiteViews),
                                            comments: stat(UGCStatisticType::Comments),
                                            upvotes: u64::from(item.num_upvotes),
                                            downvotes: u64::from(item.num_downvotes),
                                            seconds_played: stat(UGCStatisticType::SecondsPlayed),
                                            playtime_sessions: stat(UGCStatisticType::PlaytimeSessions),
                                        }
                                    },
                                    content_path: None,
                                    history: Vec::new(),
                                })
                            })
                            .collect();
                        (batch, results.total_results())
                    }));
                })
            })?
            .map_err(steam_error)?;
            let done = batch.is_empty() || page * PAGE_SIZE >= total;
            items.extend(batch);
            if done {
                break;
            }
        }
        Ok(items)
    }

    /// Creates the item if needed, then sends the page and any files to Steam.
    pub fn publish(
        &'static self,
        request: &PublishRequest,
        mut report: impl FnMut(PublishProgress),
    ) -> Result<PublishOutcome, PublishError> {
        let send_page = request.send_page || request.item_id.is_none();
        let title = request.title.trim();
        if send_page {
            if title.is_empty() {
                return Err("Give the item a title.".into());
            }
            check_text("title", title, MAX_TITLE_BYTES)?;
            check_text("description", &request.description, MAX_DESCRIPTION_BYTES)?;
            if request.tags.iter().any(|t| t.contains(',')) {
                return Err("Tags can't contain commas.".into());
            }
            if request.tags.iter().any(|t| t.contains('\0')) {
                return Err("A tag contains a null character.".into());
            }
            check_text("tag list", &request.tags.join(","), MAX_TAG_LIST_BYTES)?;
        }
        let note = request.change_note.trim();
        check_text("change note", note, MAX_CHANGE_NOTE_BYTES)?;
        // Paths are resolved here because the steamworks crate panics on one it can't resolve.
        let content = match request.content_path.as_deref().map(str::trim) {
            Some(path) if !Path::new(path).is_dir() => return Err(format!("{path} isn't a folder.").into()),
            Some(path) => Some(std::fs::canonicalize(path).map_err(|e| format!("Couldn't open {path}: {e}"))?),
            None if request.item_id.is_none() => return Err("Choose the folder to upload.".into()),
            None => None,
        };
        let preview = match request.preview_path.as_deref().map(str::trim) {
            Some(path) => {
                let size = std::fs::metadata(path).map_err(|e| format!("Couldn't read the preview image: {e}"))?.len();
                if size > MAX_PREVIEW_BYTES {
                    return Err("The preview image is over 1 MB, which is Steam's limit.".into());
                }
                Some(std::fs::canonicalize(path).map_err(|e| format!("Couldn't read the preview image: {e}"))?)
            }
            None if request.default_preview => Some(default_preview()?),
            None => None,
        };

        let session = self.session()?;
        let ugc = session.client.ugc();
        let mut needs_agreement = false;

        let (id, created) = match request.item_id.as_deref() {
            Some(id) => (parse_id(id)?, false),
            None => {
                report(PublishProgress { item_id: None, stage: PublishStage::Creating, processed: 0, total: 0 });
                let (id, agreement) = wait(|tx| {
                    ugc.create_item(DAYZ, FileType::Community, move |result| {
                        let _ = tx.send(result);
                    })
                })?
                .map_err(steam_error)?;
                needs_agreement |= agreement;
                (id, true)
            }
        };
        let item_id = Some(id.0.to_string());
        let failed = |message: String| PublishError { message, item_id: created.then(|| id.0.to_string()) };

        // Servers report the mod's Workshop ID from meta.cpp, and the upload replaces every file, so it goes in each
        // time, as DayZ Publisher does.
        if let Some(path) = &content {
            crate::build::write_output(&path.join("meta.cpp"), crate::meta_cpp::create(id.0, title, SystemTime::now()))
                .map_err(|e| failed(format!("Couldn't write meta.cpp into the folder: {e}")))?;
        }

        // Steam leaves anything not set on the update as it is.
        let mut update = ugc.start_item_update(DAYZ, id);
        if send_page {
            update = update
                .title(title)
                .description(&request.description)
                .tags(request.tags.clone(), false)
                .visibility(request.visibility.into());
        }
        if let Some(path) = &preview {
            update = update.preview_path(path);
        }
        if let Some(path) = &content {
            update = update.content_path(path);
        }

        let (tx, rx) = mpsc::channel();
        let watch = update.submit((!note.is_empty()).then_some(note), move |result| {
            let _ = tx.send(result);
        });

        let mut waited = Duration::ZERO;
        let mut alive = AliveCheck::new();
        let result = loop {
            match rx.recv_timeout(PROGRESS_INTERVAL) {
                Ok(result) => break result,
                Err(RecvTimeoutError::Disconnected) => return Err(failed("Lost the connection to Steam.".into())),
                Err(RecvTimeoutError::Timeout) => {
                    waited += PROGRESS_INTERVAL;
                    if waited > UPLOAD_TIMEOUT {
                        return Err(failed(
                            "The upload didn't finish. Check Steam's downloads page and try again.".into(),
                        ));
                    }
                    alive.check().map_err(failed)?;
                    let (status, processed, total) = watch.progress();
                    let stage = match status {
                        UpdateStatus::UploadingContent => PublishStage::UploadingContent,
                        UpdateStatus::UploadingPreviewFile => PublishStage::UploadingPreview,
                        UpdateStatus::CommittingChanges => PublishStage::Committing,
                        _ => PublishStage::Preparing,
                    };
                    report(PublishProgress { item_id: item_id.clone(), stage, processed, total });
                }
            }
        };
        let (_, agreement) = result.map_err(|e| failed(steam_error(e)))?;
        Ok(PublishOutcome { item_id: id.0.to_string(), needs_agreement: needs_agreement || agreement })
    }
}
