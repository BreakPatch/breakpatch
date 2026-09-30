//! Issue trackers for Create issue (roadmap #5, Team): GitHub, Linear and Jira Cloud, each with a
//! personal token the person saves on this Mac. The token is kept in the Keychain, service
//! `dev.breakpatch.trackers`, and only these commands use it: it never goes back to the webview or
//! into the workspace. A small JSON index in the app data dir says which trackers are set up and as
//! whom (never a token). The calls go only to fixed hosts: `api.github.com`, `api.linear.app` and
//! `<site>.atlassian.net`; a Linear screenshot goes to the upload address Linear gives for it.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::secrets::SecretStore;

pub const SERVICE: &str = "dev.breakpatch.trackers";
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Github,
    Linear,
    Jira,
}

impl Provider {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "github" => Ok(Self::Github),
            "linear" => Ok(Self::Linear),
            "jira" => Ok(Self::Jira),
            _ => Err("provider must be github, linear or jira".into()),
        }
    }
    fn key(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Linear => "linear",
            Self::Jira => "jira",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Github => "GitHub",
            Self::Linear => "Linear",
            Self::Jira => "Jira",
        }
    }
}

/// A tracker set up on this Mac, as the UI sees it: never the token.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackerStatus {
    pub provider: Provider,
    /// Who the token belongs to: the GitHub login, the Linear or Jira name.
    pub account: String,
    /// Jira only: `acme.atlassian.net` and the email the API token goes with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// What Create issue sends: the text (built in the UI) and where it goes (the workspace's settings).
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct IssueRequest {
    pub title: String,
    /// Markdown (GitHub, Linear).
    #[serde(default)]
    pub body: String,
    /// Jira: the description as Atlassian Document Format.
    #[serde(default)]
    pub description: Option<Value>,
    /// GitHub: `owner/repo`.
    #[serde(default)]
    pub repo: Option<String>,
    /// Linear: the team's key, e.g. `ENG`.
    #[serde(default)]
    pub team: Option<String>,
    /// Jira: the project key and the issue type's name.
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub issue_type: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    /// A failure screenshot on this Mac (Jira attaches it, Linear uploads and embeds it).
    #[serde(default)]
    pub screenshot_path: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreatedIssue {
    pub key: String,
    pub url: String,
    /// "attached", "none" (nothing to add) or "failed" (the issue is made, the picture isn't).
    pub screenshot: &'static str,
}

// ---------------------------------------------------------------- where the calls go

/// The API addresses. `production()` everywhere but tests, which point them at a local server.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub github: String,
    pub linear: String,
    /// None: `https://<site>` for Jira; tests give their own.
    pub jira: Option<String>,
    /// Tests only: a Linear upload address may be plain http (their local server).
    pub allow_http_upload: bool,
}

impl Endpoints {
    pub fn production() -> Self {
        Self {
            github: "https://api.github.com".into(),
            linear: "https://api.linear.app/graphql".into(),
            jira: None,
            allow_http_upload: false,
        }
    }
    fn jira_base(&self, site: &str) -> String {
        self.jira.clone().unwrap_or_else(|| format!("https://{site}"))
    }
}

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Breakpatch/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- checks

/// `acme`, `acme.atlassian.net` or `https://acme.atlassian.net/jira/…` → `acme.atlassian.net`.
pub fn normalize_site(text: &str) -> Result<String, String> {
    let bad = || "Use your Jira site's address, like acme.atlassian.net.".to_string();
    let t = text.trim().trim_start_matches("https://").trim_start_matches("http://");
    let host = t.split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase();
    let host = if host.contains('.') { host } else { format!("{host}.atlassian.net") };
    let name = host.strip_suffix(".atlassian.net").ok_or_else(bad)?;
    let ok = !name.is_empty()
        && name.len() <= 63
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !name.starts_with('-');
    if ok { Ok(host) } else { Err(bad()) }
}

fn valid_repo(r: &str) -> bool {
    let mut parts = r.split('/');
    let ok = |p: Option<&str>| {
        p.is_some_and(|p| {
            !p.is_empty() && p.len() <= 100 && !p.starts_with('.') && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

fn valid_key(k: &str, max: usize) -> bool {
    !k.is_empty() && k.len() <= max && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn check_request(p: Provider, r: &IssueRequest) -> Result<(), String> {
    if r.title.trim().is_empty() || r.title.chars().count() > 250 {
        return Err("The issue needs a title of up to 250 characters.".into());
    }
    if r.body.len() > 60_000 {
        return Err("The issue text is too long.".into());
    }
    if r.labels.len() > 20 || r.labels.iter().any(|l| l.trim().is_empty() || l.len() > 50) {
        return Err("Up to 20 labels, each up to 50 characters.".into());
    }
    match p {
        Provider::Github if !r.repo.as_deref().is_some_and(valid_repo) => {
            Err("Say which GitHub repository, like acme/web, in Settings → Issue trackers.".into())
        }
        Provider::Linear if !r.team.as_deref().is_some_and(|t| valid_key(t, 16)) => {
            Err("Say which Linear team, by its key like ENG, in Settings → Issue trackers.".into())
        }
        Provider::Jira if !r.project.as_deref().is_some_and(|t| valid_key(t, 20)) => {
            Err("Say which Jira project, by its key like WEB, in Settings → Issue trackers.".into())
        }
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------- replies

fn reach_error(e: reqwest::Error, who: &str) -> String {
    if e.is_timeout() {
        format!("{who} didn't answer within {} seconds. Try again.", TIMEOUT.as_secs())
    } else {
        format!("Couldn't reach {who}. Check this Mac's connection and try again.")
    }
}

async fn json_of(res: reqwest::Response) -> (u16, Value) {
    let status = res.status().as_u16();
    let text = tokio::time::timeout(Duration::from_secs(10), res.text()).await.ok().and_then(Result::ok).unwrap_or_default();
    (status, serde_json::from_str(&text).unwrap_or(Value::String(crate::runner::reply_excerpt(&text))))
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for p in path {
        cur = cur.get(*p)?;
    }
    cur.as_str()
}

/// Jira's `{"errorMessages": [...], "errors": {"field": "..."}}` as one line.
fn jira_messages(v: &Value) -> String {
    let mut out: Vec<String> = v["errorMessages"].as_array().into_iter().flatten().filter_map(|m| m.as_str().map(String::from)).collect();
    if let Some(map) = v["errors"].as_object() {
        out.extend(map.iter().filter_map(|(k, m)| m.as_str().map(|m| format!("{k}: {m}"))));
    }
    out.join(" ")
}

// ---------------------------------------------------------------- checking a token

/// Asks the tracker who the token belongs to: the account name to show, or why it didn't work.
pub async fn verify(
    c: &reqwest::Client,
    e: &Endpoints,
    p: Provider,
    token: &str,
    email: Option<&str>,
    site: Option<&str>,
) -> Result<String, String> {
    if token.trim().is_empty() {
        return Err("Paste the token first.".into());
    }
    let token = token.trim();
    match p {
        Provider::Github => {
            let res = github(c, e, reqwest::Method::GET, "/user", token).send().await.map_err(|x| reach_error(x, "GitHub"))?;
            match json_of(res).await {
                (200, v) => Ok(str_at(&v, &["login"]).unwrap_or("GitHub").to_string()),
                (401, _) => Err("GitHub didn't accept the token. Check it was copied whole and hasn't expired.".into()),
                (s, _) => Err(format!("GitHub answered {s} when checking the token.")),
            }
        }
        Provider::Linear => {
            let v = linear(c, e, token, "query { viewer { name email } }", json!({})).await?;
            Ok(str_at(&v, &["data", "viewer", "name"]).unwrap_or("Linear").to_string())
        }
        Provider::Jira => {
            let (site, email) = jira_who(email, site)?;
            let res = c
                .get(format!("{}/rest/api/3/myself", e.jira_base(&site)))
                .basic_auth(&email, Some(token))
                .header("Accept", "application/json")
                .send()
                .await
                .map_err(|x| reach_error(x, "Jira"))?;
            match json_of(res).await {
                (200, v) => Ok(str_at(&v, &["displayName"]).unwrap_or(&email).to_string()),
                (401 | 403, _) => Err(format!("Jira didn't accept {email} with that API token.")),
                (404, _) => Err(format!("There's no Jira site at {site}.")),
                (s, _) => Err(format!("Jira answered {s} when checking the token.")),
            }
        }
    }
}

fn jira_who(email: Option<&str>, site: Option<&str>) -> Result<(String, String), String> {
    let site = normalize_site(site.unwrap_or(""))?;
    let email = email.map(str::trim).filter(|m| m.contains('@') && m.len() < 200).ok_or("Jira needs the email you sign in to Jira with.")?;
    Ok((site, email.to_string()))
}

fn github(c: &reqwest::Client, e: &Endpoints, m: reqwest::Method, path: &str, token: &str) -> reqwest::RequestBuilder {
    c.request(m, format!("{}{path}", e.github))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
}

/// One GraphQL call; `data`, or GraphQL's own error in plain words.
async fn linear(c: &reqwest::Client, e: &Endpoints, key: &str, query: &str, variables: Value) -> Result<Value, String> {
    // A personal API key goes as it is (no "Bearer"), per Linear's docs.
    let res = c
        .post(&e.linear)
        .header("Authorization", key)
        .json(&json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|x| reach_error(x, "Linear"))?;
    let (status, v) = json_of(res).await;
    let gql = v["errors"][0]["message"].as_str().map(str::to_string);
    let auth = v["errors"][0]["extensions"]["code"].as_str() == Some("AUTHENTICATION_ERROR");
    if auth || status == 401 {
        return Err("Linear didn't accept the API key. Check it was copied whole.".into());
    }
    match (status, gql) {
        (_, Some(m)) => Err(format!("Linear said: {m}")),
        (200, None) => Ok(v),
        (s, None) => Err(format!("Linear answered {s}.")),
    }
}

// ---------------------------------------------------------------- making an issue

pub async fn create_issue(
    c: &reqwest::Client,
    e: &Endpoints,
    p: Provider,
    token: &str,
    who: &TrackerStatus,
    r: &IssueRequest,
    shot: Option<Vec<u8>>,
) -> Result<CreatedIssue, String> {
    check_request(p, r)?;
    let labels: Vec<&str> = r.labels.iter().map(|l| l.trim()).collect();
    match p {
        Provider::Github => {
            let repo = r.repo.as_deref().unwrap_or_default();
            let mut body = json!({ "title": r.title.trim(), "body": r.body });
            if !labels.is_empty() {
                body["labels"] = json!(labels);
            }
            let res = github(c, e, reqwest::Method::POST, &format!("/repos/{repo}/issues"), token)
                .json(&body)
                .send()
                .await
                .map_err(|x| reach_error(x, "GitHub"))?;
            match json_of(res).await {
                (201, v) => Ok(CreatedIssue {
                    key: format!("{repo}#{}", v["number"].as_u64().unwrap_or(0)),
                    url: str_at(&v, &["html_url"]).unwrap_or_default().to_string(),
                    screenshot: "none",
                }),
                (401, _) => Err("GitHub didn't accept the token any more. Save a new one in Settings → Issue trackers.".into()),
                (403 | 404, _) => Err(format!(
                    "GitHub said the token can't create issues in {repo}. Give it access to that repository with Issues: Read and write."
                )),
                (410, _) => Err(format!("Issues are turned off in {repo}.")),
                (422, v) => Err(format!(
                    "GitHub didn't take the issue: {}.",
                    v["errors"][0]["message"].as_str().or(str_at(&v, &["message"])).unwrap_or("it said the details aren't valid").trim_end_matches('.')
                )),
                (s, _) => Err(format!("GitHub answered {s}.")),
            }
        }
        Provider::Linear => {
            let key = r.team.as_deref().unwrap_or_default();
            let teams = linear(c, e, token, "query($key: String!) { teams(filter: { key: { eqIgnoreCase: $key } }) { nodes { id name } } }", json!({ "key": key })).await?;
            let team = teams["data"]["teams"]["nodes"][0]["id"]
                .as_str()
                .ok_or_else(|| format!("Linear has no team {key} that this API key can see."))?
                .to_string();
            let mut description = r.body.clone();
            let mut screenshot = "none";
            if let Some(bytes) = shot {
                match linear_upload(c, e, token, bytes).await {
                    Ok(asset) => {
                        description.push_str(&format!("\n![Screenshot]({asset})\n"));
                        screenshot = "attached";
                    }
                    Err(err) => {
                        log::warn!("linear upload: {err}");
                        screenshot = "failed";
                    }
                }
            }
            let v = linear(
                c,
                e,
                token,
                "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
                json!({ "input": { "teamId": team, "title": r.title.trim(), "description": description } }),
            )
            .await?;
            let issue = &v["data"]["issueCreate"]["issue"];
            match (str_at(issue, &["identifier"]), str_at(issue, &["url"])) {
                (Some(k), Some(u)) => Ok(CreatedIssue { key: k.into(), url: u.into(), screenshot }),
                _ => Err("Linear didn't make the issue.".into()),
            }
        }
        Provider::Jira => {
            let site = who.site.clone().ok_or("Set up Jira again in Settings → Issue trackers.")?;
            let email = who.email.clone().ok_or("Set up Jira again in Settings → Issue trackers.")?;
            let project = r.project.as_deref().unwrap_or_default().to_ascii_uppercase();
            let base = e.jira_base(&site);
            let description = r.description.clone().unwrap_or_else(|| adf_text(&r.body));
            let mut fields = json!({
                "project": { "key": project },
                "summary": r.title.trim(),
                "issuetype": { "name": r.issue_type.as_deref().map(str::trim).filter(|t| !t.is_empty()).unwrap_or("Bug") },
                "description": description,
            });
            if !labels.is_empty() {
                // Jira labels can't have spaces.
                fields["labels"] = json!(labels.iter().map(|l| l.replace(' ', "-")).collect::<Vec<_>>());
            }
            let res = c
                .post(format!("{base}/rest/api/3/issue"))
                .basic_auth(&email, Some(token))
                .header("Accept", "application/json")
                .json(&json!({ "fields": fields }))
                .send()
                .await
                .map_err(|x| reach_error(x, "Jira"))?;
            let key = match json_of(res).await {
                (201, v) => str_at(&v, &["key"]).unwrap_or_default().to_string(),
                (401, _) => return Err(format!("Jira didn't accept {email} with the saved API token. Save a new one in Settings → Issue trackers.")),
                (403, _) => return Err(format!("Jira said {email} can't create issues in {project}.")),
                (404, _) => return Err(format!("Jira has no project {project}, or {email} can't see it.")),
                (400, v) => return Err(format!("Jira didn't take the issue: {}", jira_messages(&v))),
                (s, _) => return Err(format!("Jira answered {s}.")),
            };
            let mut screenshot = "none";
            if let Some(bytes) = shot {
                screenshot = match jira_attach(c, &base, &email, token, &key, bytes).await {
                    Ok(()) => "attached",
                    Err(err) => {
                        log::warn!("jira attachment: {err}");
                        "failed"
                    }
                };
            }
            Ok(CreatedIssue { url: format!("https://{site}/browse/{key}"), key, screenshot })
        }
    }
}

/// Plain text as Atlassian Document Format, one paragraph per block (when the UI sends no ADF).
pub fn adf_text(text: &str) -> Value {
    let paras: Vec<Value> = text
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| json!({ "type": "paragraph", "content": [{ "type": "text", "text": p }] }))
        .collect();
    json!({ "type": "doc", "version": 1, "content": paras })
}

const BOUNDARY: &str = "breakpatch-screenshot-7f3a9c1e";

/// `multipart/form-data` with one file part, built by hand (reqwest's multipart isn't in the lockfile).
pub fn multipart_png(bytes: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"screenshot.png\"\r\nContent-Type: image/png\r\n\r\n"
    )
    .into_bytes();
    out.extend_from_slice(bytes);
    out.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    out
}

async fn jira_attach(c: &reqwest::Client, base: &str, email: &str, token: &str, key: &str, bytes: Vec<u8>) -> Result<(), String> {
    let res = c
        .post(format!("{base}/rest/api/3/issue/{key}/attachments"))
        .basic_auth(email, Some(token))
        .header("X-Atlassian-Token", "no-check")
        .header("Content-Type", format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(multipart_png(&bytes))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let s = res.status().as_u16();
    if s == 200 { Ok(()) } else { Err(format!("answered {s}")) }
}

/// Linear's upload: ask for an upload address, PUT the picture there, return its asset address.
async fn linear_upload(c: &reqwest::Client, e: &Endpoints, key: &str, bytes: Vec<u8>) -> Result<String, String> {
    let v = linear(
        c,
        e,
        key,
        "mutation($size: Int!) { fileUpload(contentType: \"image/png\", filename: \"screenshot.png\", size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }",
        json!({ "size": bytes.len() }),
    )
    .await?;
    let f = &v["data"]["fileUpload"]["uploadFile"];
    let (Some(upload), Some(asset)) = (str_at(f, &["uploadUrl"]), str_at(f, &["assetUrl"])) else {
        return Err("no upload address".into());
    };
    let u = url::Url::parse(upload).map_err(|e| e.to_string())?;
    if u.scheme() != "https" && !(e.allow_http_upload && u.scheme() == "http") {
        return Err("the upload address isn't https".into());
    }
    let mut req = c.put(u).header("Content-Type", "image/png").header("Cache-Control", "public, max-age=31536000");
    for h in f["headers"].as_array().into_iter().flatten() {
        if let (Some(k), Some(val)) = (h["key"].as_str(), h["value"].as_str()) {
            req = req.header(k, val);
        }
    }
    let res = req.body(bytes).send().await.map_err(|e| e.to_string())?;
    if res.status().is_success() { Ok(asset.to_string()) } else { Err(format!("upload answered {}", res.status().as_u16())) }
}

// ---------------------------------------------------------------- tokens on this Mac

#[derive(Serialize, Deserialize, Default)]
struct IndexFile {
    version: u32,
    trackers: BTreeMap<String, TrackerStatus>,
}

/// Tokens in the Keychain (one entry per provider), who they belong to in `trackers.json`.
pub struct Trackers<S: SecretStore> {
    store: S,
    index: PathBuf,
    lock: Mutex<()>,
}

impl<S: SecretStore> Trackers<S> {
    pub fn new(store: S, index: PathBuf) -> Self {
        Self { store, index, lock: Mutex::new(()) }
    }

    fn load(&self) -> BTreeMap<String, TrackerStatus> {
        fs::read_to_string(&self.index)
            .ok()
            .and_then(|t| serde_json::from_str::<IndexFile>(&t).ok())
            .map(|f| f.trackers)
            .unwrap_or_default()
    }

    fn save_index(&self, all: &BTreeMap<String, TrackerStatus>) -> Result<(), String> {
        if let Some(dir) = self.index.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.index.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(&IndexFile { version: 1, trackers: all.clone() }).map_err(|e| e.to_string())?;
        fs::write(&tmp, text).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.index).map_err(|e| e.to_string())
    }

    pub fn status(&self) -> Vec<TrackerStatus> {
        let _g = self.lock.lock().unwrap();
        self.load().into_values().collect()
    }

    pub fn get(&self, p: Provider) -> Result<(String, TrackerStatus), String> {
        let _g = self.lock.lock().unwrap();
        let who = self.load().get(p.key()).cloned().ok_or_else(|| format!("{} isn't set up on this Mac. Add it in Settings → Issue trackers.", p.name()))?;
        let token = self.store.get(p.key())?.ok_or_else(|| format!("The {} token isn't on this Mac any more. Add it again in Settings → Issue trackers.", p.name()))?;
        Ok((token, who))
    }

    pub fn put(&self, who: TrackerStatus, token: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        self.store.set(who.provider.key(), token.trim())?;
        let mut all = self.load();
        all.insert(who.provider.key().into(), who);
        self.save_index(&all)
    }

    pub fn forget(&self, p: Provider) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        self.store.delete(p.key())?;
        let mut all = self.load();
        if all.remove(p.key()).is_some() {
            self.save_index(&all)?;
        }
        Ok(())
    }
}

/// Checks the token online, then keeps it: what the UI shows afterwards.
pub async fn save<S: SecretStore>(
    t: &Trackers<S>,
    c: &reqwest::Client,
    e: &Endpoints,
    p: Provider,
    token: &str,
    email: Option<String>,
    site: Option<String>,
) -> Result<TrackerStatus, String> {
    let account = verify(c, e, p, token, email.as_deref(), site.as_deref()).await?;
    let (site, email) = if p == Provider::Jira {
        let (s, m) = jira_who(email.as_deref(), site.as_deref())?;
        (Some(s), Some(m))
    } else {
        (None, None)
    };
    let who = TrackerStatus { provider: p, account, site, email };
    t.put(who.clone(), token)?;
    Ok(who)
}

#[cfg(test)]
#[path = "trackers_tests.rs"]
mod tests;
