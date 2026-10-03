//! Breakpatch desktop shell: window, engine sidecar, Keychain secrets, tests folder, file association,
//! deep links, updater, runner-mode helpers, the Team licence check (licence.rs), the usage counts
//! (usage.rs), the last step of Upgrade to Team (migration.rs), result messages (runner.rs),
//! the issue trackers for Create issue (trackers.rs) and the workspace keys that seal test content
//! (workspace_keys.rs). The UI calls these through
//! `platform.ts`, `lib/usage.ts`, `engine/sidecarEngine.ts` and `lib/updates.ts`.

mod engine;
mod folder;
mod licence;
mod migration;
mod net;
mod results;
mod runner;
mod secrets;
mod trackers;
mod usage;
mod workspace;
mod workspace_keys;

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::Value;
use tauri::{Manager, RunEvent, State};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};

use engine::EngineHost;
use licence::{ActivateRequest, Failure, KeyTable, Licensing};
use runner::KeepAwake;
use secrets::{KeyringStore, Secrets, SecretsIndex};
use usage::UsageStore;
use workspace::WorkspaceInbox;

type SecretsState = Arc<Secrets<KeyringStore>>;
type LicenceState = Arc<Licensing<KeyringStore>>;
type UsageState = Arc<UsageStore>;
type TrackersState = Arc<trackers::Trackers<KeyringStore>>;
/// Result addresses of suites in a tests folder (results.rs).
type ResultsState = Arc<results::ResultAddresses<KeyringStore>>;

// ---- Engine ----------------------------------------------------------------------------

/// Resolves with the engine's `result`, or rejects with the JSON string `{code, message, details}`.
/// Saved secrets in `run.start`, `record.point` and `call.try` get their sites and runner flag
/// from the Keychain index here (secrets.rs `attach_policies`), whatever the UI sent.
#[tauri::command]
async fn engine_request(
    host: State<'_, Arc<EngineHost>>,
    secrets: State<'_, SecretsState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    if !engine::forwardable(&method) {
        return Err(engine::EngineError::new("bad_request", "The app hands the engine its licence itself.", method)
            .to_json_string());
    }
    let mut params = params.unwrap_or(Value::Null);
    if secrets::carries_secrets(&method) && params.get("secrets").is_some() {
        let s = Arc::clone(&secrets);
        let policies = blocking(move || Ok(s.policies())).await?;
        secrets::attach_policies(&mut params, &policies);
    }
    host.request(&method, params).await.map_err(|e| e.to_json_string())
}

// ---- Secrets (Keychain calls can block on a prompt, so they run off the main thread) ------

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn secrets_list(s: State<'_, SecretsState>) -> Result<Vec<String>, String> {
    let s = Arc::clone(&s);
    blocking(move || Ok(s.list())).await
}

/// Names with their sites and "Runner can use" flag, never values.
#[tauri::command]
async fn secrets_info(s: State<'_, SecretsState>) -> Result<Vec<secrets::SecretInfo>, String> {
    let s = Arc::clone(&s);
    blocking(move || Ok(s.info())).await
}

/// Saves a value. `origins` and `runnerCanUse` set where it may be used; left out, they stay.
#[tauri::command]
async fn secrets_set(
    s: State<'_, SecretsState>,
    name: String,
    value: String,
    origins: Option<Vec<String>>,
    runner_can_use: Option<bool>,
) -> Result<(), String> {
    let s = Arc::clone(&s);
    blocking(move || s.set(&name, &value, origins, runner_can_use)).await
}

/// Changes where a saved secret may be used, without its value.
#[tauri::command]
async fn secrets_set_policy(
    s: State<'_, SecretsState>,
    name: String,
    origins: Vec<String>,
    runner_can_use: bool,
) -> Result<(), String> {
    let s = Arc::clone(&s);
    blocking(move || s.set_policy(&name, origins, runner_can_use)).await
}

#[tauri::command]
async fn secrets_delete(s: State<'_, SecretsState>, name: String) -> Result<(), String> {
    let s = Arc::clone(&s);
    blocking(move || s.delete(&name)).await
}

#[tauri::command]
async fn secrets_resolve(s: State<'_, SecretsState>, names: Vec<String>) -> Result<BTreeMap<String, String>, String> {
    let s = Arc::clone(&s);
    blocking(move || s.resolve(&names)).await
}

// ---- Result addresses of suites in a tests folder (Solo; results.rs) ----------------------

/// A folder suite's result address, from the Keychain (None: none saved).
#[tauri::command]
async fn result_address_get(r: State<'_, ResultsState>, ws_key: String, suite_id: String) -> Result<Option<String>, String> {
    let r = Arc::clone(&r);
    blocking(move || r.get(&ws_key, &suite_id)).await
}

/// Saves a folder suite's result address in the Keychain (None: forgets it).
#[tauri::command]
async fn result_address_set(
    r: State<'_, ResultsState>,
    ws_key: String,
    suite_id: String,
    url: Option<String>,
) -> Result<(), String> {
    let r = Arc::clone(&r);
    blocking(move || r.set(&ws_key, &suite_id, url.as_deref())).await
}

// ---- Licence (Team; "not available in this edition" without built-in keys) ----------------

/// The stored licence, checked on this Mac without the network. `workspaceProjectId`: the open
/// workspace, so a licence for another one unlocks nothing. `wsKey`: the connection asked about
/// (None: the selected one).
#[tauri::command]
async fn licence_status(
    l: State<'_, LicenceState>,
    ws_key: Option<String>,
    workspace_project_id: Option<String>,
) -> Result<licence::Status, String> {
    let l = Arc::clone(&l);
    blocking(move || Ok(l.status_for(ws_key.as_deref(), workspace_project_id.as_deref()))).await
}

/// Works on this connection's licence from now on (`wsKey`, licence.rs; None: nothing unlocked).
/// `workspaceProjectId`: the Team workspace's project, so the licence of an earlier version can
/// move to it, unless `adoptLegacy` is false (another workspace of that project may own it). The
/// engine gets the selected workspace's token (or none) before this answers. This is the engine's
/// first licence hand-off after launch.
#[tauri::command]
async fn licence_select(
    l: State<'_, LicenceState>,
    host: State<'_, Arc<EngineHost>>,
    ws_key: Option<String>,
    workspace_project_id: Option<String>,
    adopt_legacy: Option<bool>,
) -> Result<licence::Status, String> {
    let l = Arc::clone(&l);
    let l2 = Arc::clone(&l);
    let adopt = adopt_legacy.unwrap_or(true);
    let st = blocking(move || l2.select_with(ws_key.as_deref(), workspace_project_id.as_deref(), adopt)).await?;
    sync_engine_licence(&l, &host).await;
    // A seat the earlier entry and this workspace's own both held: the older one goes back.
    l.release_stale().await;
    Ok(st)
}

/// Takes a seat for `wsKey`'s connection (None: the selected one): `kind` "person" (subject: the
/// signed-in email, or a Solo licence's purchase email) or "machine" (this Mac's id). An empty
/// `workspaceProjectId` is a tests folder (Solo). An empty `key` uses the key stored for `keyFrom`
/// (None: this connection). Rejects with `{code, message}`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn licence_activate(
    l: State<'_, LicenceState>,
    host: State<'_, Arc<EngineHost>>,
    ws_key: Option<String>,
    key: String,
    key_from: Option<String>,
    workspace_project_id: String,
    subject: Option<String>,
    kind: String,
) -> Result<licence::Status, Failure> {
    let l = Arc::clone(&l);
    let out = l.activate(ActivateRequest { ws_key, key, key_from, workspace_project_id, subject, kind }).await;
    sync_engine_licence(&l, &host).await;
    out
}

/// A new token for `wsKey`'s seat (None: the selected connection's).
#[tauri::command]
async fn licence_refresh(
    l: State<'_, LicenceState>,
    host: State<'_, Arc<EngineHost>>,
    ws_key: Option<String>,
) -> Result<licence::Status, String> {
    let l = Arc::clone(&l);
    let st = l.refresh_for(ws_key.as_deref()).await;
    sync_engine_licence(&l, &host).await;
    Ok(st)
}

/// Gives the seat back: the selected workspace's, or `wsKey`'s (a workspace being removed).
#[tauri::command]
async fn licence_release(
    l: State<'_, LicenceState>,
    host: State<'_, Arc<EngineHost>>,
    ws_key: Option<String>,
) -> Result<licence::Status, String> {
    let l = Arc::clone(&l);
    let st = l.release(ws_key.as_deref()).await;
    sync_engine_licence(&l, &host).await;
    Ok(st)
}

/// Hands the engine sidecar the stored token (it checks it itself; engine/PROTOCOL.md `licence.set`).
async fn sync_engine_licence(l: &LicenceState, host: &Arc<EngineHost>) {
    let l = Arc::clone(l);
    match blocking(move || Ok(l.engine_token())).await {
        Ok(token) => host.set_licence(token),
        Err(e) => log::warn!("couldn't read the licence for the engine: {e}"),
    }
}

// ---- Usage counts (usage.rs; docs/manual.md "Privacy") ---------------------------------------

fn unix_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Counts one test created (`kind` "test") or one run (`kind` "run", `source` manual | schedule |
/// runner | ci, `result` pass | fail). Numbers only: nothing about the test is passed in.
#[tauri::command]
async fn usage_record(
    u: State<'_, UsageState>,
    l: State<'_, LicenceState>,
    kind: String,
    source: Option<String>,
    result: Option<String>,
) -> Result<(), String> {
    let ev = match kind.as_str() {
        "test" => usage::Event::TestCreated,
        "run" => usage::Event::Run {
            source: source
                .as_deref()
                .and_then(usage::Source::parse)
                .ok_or("source must be manual, schedule, runner or ci")?,
            passed: result.as_deref() == Some("pass"),
        },
        _ => return Err("kind must be test or run".into()),
    };
    let (u, l) = (Arc::clone(&u), Arc::clone(&l));
    blocking(move || {
        // A Keychain read (cached after the first): Team counts only while this Mac holds the open
        // workspace's licence, in that workspace's bucket.
        let ws = (u.edition() == usage::Edition::Team && l.holds_token()).then(|| l.selected()).flatten();
        u.record(ev, unix_now(), ws.as_deref());
        Ok(())
    })
    .await
}

#[tauri::command]
fn usage_settings(u: State<'_, UsageState>, l: State<'_, LicenceState>) -> usage::Settings {
    u.settings(l.selected().as_deref())
}

/// Community: sharing on or off. Off drops what's waiting to be sent.
#[tauri::command]
fn usage_set_enabled(u: State<'_, UsageState>, on: bool) -> usage::Settings {
    u.set_enabled(on)
}

/// Community: the one-time notice was shown.
#[tauri::command]
fn usage_notice_seen(u: State<'_, UsageState>) -> usage::Settings {
    u.notice_seen()
}

/// Community: checks every hour whether today's ping is due and sends it (usage.rs).
async fn community_usage_loop(store: UsageState) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent(concat!("Breakpatch/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default();
    tokio::time::sleep(usage::FIRST_CHECK_AFTER).await;
    loop {
        usage::send_community(&store, &client, &licence::service_url(), unix_now()).await;
        tokio::time::sleep(usage::CHECK_EVERY).await;
    }
}

// ---- Workspace files ---------------------------------------------------------------------

/// A `.bpworkspace` file the app was launched with, if any (see workspace.rs).
#[tauri::command]
fn workspace_file_take(inbox: State<'_, WorkspaceInbox>) -> Option<String> {
    inbox.take()
}

// ---- Tests folder (Community) ----------------------------------------------------------

/// The person's full name, for "saved by" in the tests folder (folder.rs). None when the shell can't tell.
#[tauri::command]
async fn system_full_name() -> Option<String> {
    tauri::async_runtime::spawn_blocking(folder::full_user_name).await.ok().flatten()
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    folder::reveal(std::path::Path::new(&path))
}

// ---- Upgrade to Team: the local copy to the Trash (migration.rs) ----------------------------

/// The engine's screenshots folder: `<data>/Breakpatch/screenshots` (engine config.py, and the
/// only folder the asset scope allows). `BP_SCREENSHOTS_DIR` moves it in development builds only.
fn screenshots_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if cfg!(debug_assertions) {
        if let Some(d) = std::env::var_os("BP_SCREENSHOTS_DIR").filter(|d| !d.is_empty()) {
            return Ok(std::path::PathBuf::from(d));
        }
    }
    // The engine's folder (config.app_home): the local, not roaming, app data on Windows, the same
    // as the asset scope's $LOCALDATA there (tauri.windows.conf.json).
    #[cfg(windows)]
    let base = app.path().local_data_dir();
    #[cfg(not(windows))]
    let base = app.path().data_dir();
    Ok(base.map_err(|e| e.to_string())?.join("Breakpatch").join("screenshots"))
}

/// Moves allowed items to the Trash. `place` "folder": `names` among breakpatch.json, apps and
/// suites directly under `folder`, which must be a folder the person opened in Breakpatch (the fs
/// scope) with a valid breakpatch.json. `place` "screenshots": run folders directly under the
/// screenshots folder. Anything else is refused before anything moves. A move that stops part-way
/// answers with what moved and `error`.
#[tauri::command]
async fn trash_items(
    app: tauri::AppHandle,
    place: String,
    folder: Option<String>,
    names: Vec<String>,
) -> Result<migration::TrashResult, String> {
    use tauri_plugin_fs::FsExt;
    let place = migration::Place::parse(&place).ok_or("place must be folder or screenshots")?;
    match place {
        migration::Place::Folder => {
            let given = std::path::PathBuf::from(folder.ok_or("Which folder?")?);
            let scope = app.fs_scope();
            blocking(move || migration::trash_from_folder(&given, &names, |p| scope.is_allowed(p), migration::to_trash))
                .await
        }
        migration::Place::Screenshots => {
            let base = screenshots_dir(&app)?;
            blocking(move || migration::trash_items(place, &base, &names, migration::to_trash)).await
        }
    }
}

/// This Mac's screenshots folder, so the move only takes run folders that are really in it.
#[tauri::command]
fn screenshots_folder(app: tauri::AppHandle) -> Result<String, String> {
    screenshots_dir(&app).map(|p| p.to_string_lossy().into_owned())
}

/// The Git repository holding this folder, if any (looks for `.git`; never runs git).
#[tauri::command]
async fn git_repo_of(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        migration::git_repo_of(std::path::Path::new(&path)).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

/// Keeps an Upgrade to Team report in `<app data>/reports/` and returns where.
#[tauri::command]
async fn migration_report_save(app: tauri::AppHandle, text: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("reports");
    blocking(move || migration::save_report(&dir, unix_now(), &text).map(|p| p.to_string_lossy().into_owned())).await
}

// ---- Runner mode -------------------------------------------------------------------------

#[tauri::command]
fn runner_keep_awake(k: State<'_, KeepAwake>, on: bool) -> Result<(), String> {
    k.set(on)
}

/// Turns "open at login" on or off and returns the resulting state.
#[tauri::command]
fn runner_open_at_login(app: tauri::AppHandle, on: bool) -> Result<bool, String> {
    let al = app.autolaunch();
    if on { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    al.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn runner_open_at_login_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn system_memory_gb() -> u32 {
    runner::memory_gb()
}

/// POSTs a suite result message to the suite's result address (https only, one try with a
/// timeout; the Team runner retries) and returns the HTTP status. The webview never posts them
/// itself, so the CSP keeps connect-src to Firebase.
#[tauri::command]
async fn runner_post_result(url: String, body: Value) -> Result<u16, String> {
    runner::post_result(&url, &body).await
}

/// POSTs a result message (JSON, Slack or Teams) and answers the status with the start of the
/// reply, for "Send a test message" and the runner's messages.
#[tauri::command]
async fn runner_post_message(url: String, body: Value) -> Result<runner::PostReply, String> {
    runner::post_message(&url, &body).await
}

/// A failure screenshot's bytes (only from the engine's screenshots folder), for a result
/// message's picture or an issue. The webview can't fetch asset URLs (connect-src).
#[tauri::command]
async fn screenshot_read(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let base = screenshots_dir(&app)?;
    blocking(move || runner::read_screenshot(&base, &path)).await.map(tauri::ipc::Response::new)
}

// ---- Issue trackers (Team, Create issue; trackers.rs) ------------------------------------

/// The trackers set up on this Mac and as whom (never a token).
#[tauri::command]
async fn trackers_status(t: State<'_, TrackersState>) -> Result<Vec<trackers::TrackerStatus>, String> {
    let t = Arc::clone(&t);
    blocking(move || Ok(t.status())).await
}

/// Checks a personal token with the tracker, then keeps it in the Keychain. Jira also needs the
/// email and the site.
#[tauri::command]
async fn trackers_save(
    t: State<'_, TrackersState>,
    provider: String,
    token: String,
    email: Option<String>,
    site: Option<String>,
) -> Result<trackers::TrackerStatus, String> {
    let p = trackers::Provider::parse(&provider)?;
    let t = Arc::clone(&t);
    // The same checks as trackers::save (tested there); only the Keychain part runs in blocking.
    let who = trackers::checked(&trackers::client()?, &trackers::Endpoints::production(), p, &token, email, site).await?;
    blocking(move || {
        t.put(who.clone(), &token)?;
        Ok(who)
    })
    .await
}

#[tauri::command]
async fn trackers_forget(t: State<'_, TrackersState>, provider: String) -> Result<(), String> {
    let p = trackers::Provider::parse(&provider)?;
    let t = Arc::clone(&t);
    blocking(move || t.forget(p)).await
}

/// Makes the issue with this Mac's token, attaching the failure screenshot where the tracker
/// can take it (Jira, Linear). The token never leaves the shell.
#[tauri::command]
async fn trackers_create_issue(
    app: tauri::AppHandle,
    t: State<'_, TrackersState>,
    provider: String,
    request: trackers::IssueRequest,
) -> Result<trackers::CreatedIssue, String> {
    let p = trackers::Provider::parse(&provider)?;
    let t = Arc::clone(&t);
    let (token, who) = blocking(move || t.get(p)).await?;
    let shot = match (&request.screenshot_path, p) {
        (Some(path), trackers::Provider::Jira | trackers::Provider::Linear) => {
            let base = screenshots_dir(&app)?;
            let path = path.clone();
            blocking(move || Ok(runner::read_screenshot(&base, &path).ok())).await?
        }
        _ => None,
    };
    trackers::create_issue(&trackers::client()?, &trackers::Endpoints::production(), p, &token, &who, &request, shot).await
}

// ---- App -----------------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let engine = Arc::new(EngineHost::default());
    let engine_for_setup = Arc::clone(&engine);

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for(
                    "engine",
                    if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info },
                )
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // After fs: restores the folders picked in earlier sessions into its scope.
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        // Local notifications when a run finishes in the background (Settings, Notifications).
        .plugin(tauri_plugin_notification::init())
        // Paste buttons (platform.ts readClipboard): read text only, no bubble to confirm.
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(engine)
        .manage(KeepAwake::default())
        .manage(WorkspaceInbox::default())
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            let index = SecretsIndex::new(data_dir.join("secrets-index.json"));
            app.manage::<SecretsState>(Arc::new(Secrets::new(KeyringStore::default(), index)));
            // Workspace keys (workspace_keys.rs): test content sealed on this Mac.
            app.manage::<workspace_keys::commands::KeysState>(Arc::new(workspace_keys::WorkspaceKeys::new(
                KeyringStore::new(workspace_keys::SERVICE),
            )));
            app.manage::<ResultsState>(Arc::new(results::ResultAddresses::new(KeyringStore::new(results::SERVICE))));
            app.manage::<TrackersState>(Arc::new(trackers::Trackers::new(
                KeyringStore::new(trackers::SERVICE),
                data_dir.join("trackers.json"),
            )));
            // The fallback machine id belongs to this PC: on Windows the local app data folder, as
            // the roaming one follows a domain user to other PCs (licence.rs machine_identity).
            #[cfg(windows)]
            let machine_dir = app.path().app_local_data_dir()?;
            #[cfg(not(windows))]
            let machine_dir = data_dir.clone();
            let keys = KeyTable::compiled();
            let edition = if keys.is_empty() { usage::Edition::Community } else { usage::Edition::Team };
            let usage_store: UsageState =
                Arc::new(UsageStore::new(Some(data_dir.join("usage.json")), edition, usage::env_off()));
            app.manage::<UsageState>(Arc::clone(&usage_store));
            if edition == usage::Edition::Community {
                tauri::async_runtime::spawn(community_usage_loop(Arc::clone(&usage_store)));
            }
            let licensing: LicenceState = Arc::new(
                Licensing::new(
                    KeyringStore::new(licence::KEYCHAIN_SERVICE),
                    keys,
                    licence::service_url(),
                    Box::new(move || licence::machine_identity(&machine_dir)),
                )
                .with_usage(usage_store),
            );
            // No licence hand-off to the engine here: nothing is selected until the UI names the
            // open connection (licence_select), which hands the engine its token (or none).
            app.manage::<LicenceState>(licensing);

            // Linux/Windows pass opened files as arguments; macOS uses RunEvent::Opened.
            #[cfg(not(target_os = "macos"))]
            {
                let inbox = app.state::<WorkspaceInbox>();
                workspace::open_paths(app.handle(), &inbox, std::env::args_os().skip(1).map(std::path::PathBuf::from));
                #[cfg(debug_assertions)]
                {
                    use tauri_plugin_deep_link::DeepLinkExt;
                    if let Err(e) = app.deep_link().register_all() {
                        log::warn!("couldn't register the breakpatch:// scheme: {e}");
                    }
                }
            }

            engine_for_setup.start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_request,
            secrets_list,
            secrets_info,
            secrets_set,
            secrets_set_policy,
            secrets_delete,
            secrets_resolve,
            workspace_file_take,
            system_full_name,
            reveal_in_finder,
            runner_keep_awake,
            runner_open_at_login,
            runner_open_at_login_enabled,
            system_memory_gb,
            runner_post_result,
            runner_post_message,
            screenshot_read,
            trackers_status,
            trackers_save,
            trackers_forget,
            trackers_create_issue,
            result_address_get,
            result_address_set,
            licence_status,
            licence_select,
            licence_activate,
            licence_refresh,
            licence_release,
            usage_record,
            usage_settings,
            usage_set_enabled,
            usage_notice_seen,
            trash_items,
            screenshots_folder,
            git_repo_of,
            migration_report_save,
            workspace_keys::commands::workspace_keys_status,
            workspace_keys::commands::workspace_keys_create,
            workspace_keys::commands::workspace_keys_rotate,
            workspace_keys::commands::workspace_keys_announce,
            workspace_keys::commands::workspace_keys_endorse,
            workspace_keys::commands::workspace_keys_trust,
            workspace_keys::commands::workspace_keys_signer_trusted,
            workspace_keys::commands::workspace_keys_review,
            workspace_keys::commands::workspace_keys_revoke,
            workspace_keys::commands::workspace_keys_renew,
            workspace_keys::commands::workspace_keys_prove,
            workspace_keys::commands::workspace_keys_check_proof,
            workspace_keys::commands::workspace_keys_seal,
            workspace_keys::commands::workspace_keys_open,
            workspace_keys::commands::workspace_keys_device,
            workspace_keys::commands::workspace_keys_fingerprint,
            workspace_keys::commands::workspace_keys_grant,
            workspace_keys::commands::workspace_keys_accept,
            workspace_keys::commands::workspace_keys_recovery_new,
            workspace_keys::commands::workspace_keys_recovery_kit,
            workspace_keys::commands::workspace_keys_recovery_done,
            workspace_keys::commands::workspace_keys_recover,
            workspace_keys::commands::workspace_keys_machine_new,
            workspace_keys::commands::workspace_keys_machine_use,
            workspace_keys::commands::workspace_keys_copy_invite,
            workspace_keys::commands::workspace_keys_import_invite,
            workspace_keys::commands::workspace_keys_retire,
            workspace_keys::commands::workspace_keys_forget,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Breakpatch");

    app.run(|handle, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let paths = urls.iter().filter(|u| u.scheme() == "file").filter_map(|u| u.to_file_path().ok());
            workspace::open_paths(handle, &handle.state::<WorkspaceInbox>(), paths);
        }
        RunEvent::Exit => {
            handle.state::<Arc<EngineHost>>().shutdown();
            let _ = handle.state::<KeepAwake>().set(false);
        }
        _ => {}
    });
}

#[cfg(test)]
mod config_tests {
    use serde_json::Value;

    fn conf() -> Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    /// The webview may show local files only from the engine's screenshots folder (security
    /// review L1): not the app data, the cache or the temporary folder.
    #[test]
    fn the_asset_protocol_only_reaches_the_screenshots_folder() {
        let scope = &conf()["app"]["security"]["assetProtocol"]["scope"];
        assert_eq!(scope, &serde_json::json!(["$DATA/Breakpatch/screenshots/**"]));
    }

    /// Hosted by Breakpatch: the app calls the cloud's functions from the webview (Team
    /// app/cloud/account.ts), so connect-src must name their host, in release and in development.
    #[test]
    fn the_webview_may_call_breakpatch_cloud() {
        let security = &conf()["app"]["security"];
        for csp in ["csp", "devCsp"] {
            let src = security[csp]["connect-src"].as_str().unwrap();
            assert!(src.split(' ').any(|h| h == "https://europe-west1-breakpatch-cloud.cloudfunctions.net"), "{csp}");
        }
    }

    /// The UI may show local notifications when a run finishes (lib/notify.ts).
    #[test]
    fn the_ui_may_notify() {
        let caps: Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(caps["permissions"].as_array().unwrap().iter().any(|p| p == "notification:default"));
    }

    /// Paste buttons read the clipboard through the shell (platform.ts readClipboard), text only.
    #[test]
    fn the_ui_may_read_the_clipboard_text_only() {
        let caps: Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let clip: Vec<&str> = caps["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str())
            .filter(|p| p.starts_with("clipboard-manager:"))
            .collect();
        assert_eq!(clip, ["clipboard-manager:allow-read-text"]);
    }

    /// Export as PDF prints the report (lib/report/print.ts): on macOS window.print() goes through
    /// the shell's webview print, which opens the print dialog with Save as PDF.
    #[test]
    fn the_ui_may_print() {
        let caps: Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(caps["permissions"].as_array().unwrap().iter().any(|p| p == "core:webview:allow-print"));
    }

    /// The local backend checks a test file's size before reading it (localBackend.ts).
    #[test]
    fn the_ui_may_ask_a_files_size() {
        let caps: Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(caps["permissions"].as_array().unwrap().iter().any(|p| p == "fs:allow-stat"));
    }
}
