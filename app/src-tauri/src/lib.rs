//! Breakpatch desktop shell: window, engine sidecar, Keychain secrets, tests folder, file association,
//! deep links, updater, runner-mode helpers, the Team licence check (licence.rs) and the usage counts
//! (usage.rs). The UI calls these through `platform.ts`, `lib/usage.ts`,
//! `engine/sidecarEngine.ts` and `lib/updates.ts`.

mod engine;
mod folder;
mod licence;
mod runner;
mod secrets;
mod usage;
mod workspace;

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

// ---- Licence (Team; "not available in this edition" without built-in keys) ----------------

/// The stored licence, checked on this Mac without the network. `workspaceProjectId`: the open
/// workspace, so a licence for another one unlocks nothing.
#[tauri::command]
async fn licence_status(
    l: State<'_, LicenceState>,
    workspace_project_id: Option<String>,
) -> Result<licence::Status, String> {
    let l = Arc::clone(&l);
    blocking(move || Ok(l.status(workspace_project_id.as_deref()))).await
}

/// Takes a seat: `kind` "person" (subject: the signed-in email) or "machine" (this Mac's id).
/// Rejects with `{code, message}`.
#[tauri::command]
async fn licence_activate(
    l: State<'_, LicenceState>,
    host: State<'_, Arc<EngineHost>>,
    key: String,
    workspace_project_id: String,
    subject: Option<String>,
    kind: String,
) -> Result<licence::Status, Failure> {
    let l = Arc::clone(&l);
    let out = l.activate(ActivateRequest { key, workspace_project_id, subject, kind }).await;
    sync_engine_licence(&l, &host).await;
    out
}

#[tauri::command]
async fn licence_refresh(
    l: State<'_, LicenceState>,
    host: State<'_, Arc<EngineHost>>,
) -> Result<licence::Status, String> {
    let l = Arc::clone(&l);
    let st = l.refresh().await;
    sync_engine_licence(&l, &host).await;
    Ok(st)
}

#[tauri::command]
async fn licence_release(
    l: State<'_, LicenceState>,
    host: State<'_, Arc<EngineHost>>,
) -> Result<licence::Status, String> {
    let l = Arc::clone(&l);
    let st = l.release().await;
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
        // A Keychain read (cached after the first): Team counts only while this Mac holds a licence.
        let licensed = u.edition() == usage::Edition::Team && l.holds_token();
        u.record(ev, unix_now(), licensed);
        Ok(())
    })
    .await
}

#[tauri::command]
fn usage_settings(u: State<'_, UsageState>) -> usage::Settings {
    u.settings()
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

/// The macOS full name, for "saved by" in the tests folder. None when the shell can't tell.
#[tauri::command]
async fn system_full_name() -> Option<String> {
    tauri::async_runtime::spawn_blocking(folder::full_user_name).await.ok().flatten()
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    folder::reveal(std::path::Path::new(&path))
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
        .manage(engine)
        .manage(KeepAwake::default())
        .manage(WorkspaceInbox::default())
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            let index = SecretsIndex::new(data_dir.join("secrets-index.json"));
            app.manage::<SecretsState>(Arc::new(Secrets::new(KeyringStore::default(), index)));
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
            app.manage::<LicenceState>(Arc::clone(&licensing));
            // The engine gets the stored token once it's read (off the main thread: a Keychain read
            // can wait on a prompt), and again after every start and licence change.
            let host = Arc::clone(&engine_for_setup);
            tauri::async_runtime::spawn(async move { sync_engine_licence(&licensing, &host).await });

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
            licence_status,
            licence_activate,
            licence_refresh,
            licence_release,
            usage_record,
            usage_settings,
            usage_set_enabled,
            usage_notice_seen,
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

    /// The UI may show local notifications when a run finishes (lib/notify.ts).
    #[test]
    fn the_ui_may_notify() {
        let caps: Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(caps["permissions"].as_array().unwrap().iter().any(|p| p == "notification:default"));
    }

    /// The local backend checks a test file's size before reading it (localBackend.ts).
    #[test]
    fn the_ui_may_ask_a_files_size() {
        let caps: Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(caps["permissions"].as_array().unwrap().iter().any(|p| p == "fs:allow-stat"));
    }
}
