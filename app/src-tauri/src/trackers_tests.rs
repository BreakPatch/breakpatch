//! trackers.rs against a local fake of GitHub, Linear and Jira: the auth header each wants, the
//! calls in order, the screenshot upload, and the errors in plain words.
use super::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Clone)]
struct Req {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl Req {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    fn header(&self, k: &str) -> &str {
        self.headers.get(k).map(String::as_str).unwrap_or("")
    }
}

/// Answers each request with the next scripted (status, body) and keeps the requests.
struct Fake {
    base: String,
    got: Arc<Mutex<Vec<Req>>>,
}

async fn fake(replies: Vec<(u16, String)>) -> Fake {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let got = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&got);
    let me = base.clone();
    tokio::spawn(async move {
        for (status, body) in replies {
            // "{BASE}" in a reply is this server's own address (e.g. an upload address).
            let body = body.replace("{BASE}", &me);
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            let (head_end, len) = loop {
                let n = sock.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..i]).to_string();
                    let len = head
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    break (i, len);
                }
                if n == 0 {
                    return;
                }
            };
            while buf.len() < head_end + 4 + len {
                let n = sock.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
            let mut lines = head.lines();
            let first: Vec<&str> = lines.next().unwrap().split(' ').collect();
            let headers = lines
                .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())))
                .collect();
            seen.lock().unwrap().push(Req {
                method: first[0].into(),
                path: first[1].into(),
                headers,
                body: buf[head_end + 4..head_end + 4 + len].to_vec(),
            });
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            sock.write_all(reply.as_bytes()).await.unwrap();
            let _ = sock.shutdown().await;
        }
    });
    Fake { base, got }
}

impl Fake {
    fn endpoints(&self) -> Endpoints {
        Endpoints {
            github: self.base.clone(),
            linear: format!("{}/graphql", self.base),
            jira: Some(self.base.clone()),
            allow_http_upload: true,
        }
    }
    fn got(&self) -> Vec<Req> {
        self.got.lock().unwrap().clone()
    }
}

fn gh(repo: &str) -> IssueRequest {
    IssueRequest {
        title: "Create a project: step 5 Click Done failed".into(),
        body: "**Couldn't find the Done button.**".into(),
        repo: Some(repo.into()),
        labels: vec!["breakpatch".into()],
        ..Default::default()
    }
}

fn who(p: Provider) -> TrackerStatus {
    TrackerStatus {
        provider: p,
        account: "Ana".into(),
        site: (p == Provider::Jira).then(|| "acme.atlassian.net".into()),
        email: (p == Provider::Jira).then(|| "ana@acme.com".into()),
    }
}

// ---------------------------------------------------------------- GitHub

#[tokio::test]
async fn github_checks_the_token_and_creates_the_issue_with_a_bearer_token() {
    let f = fake(vec![
        (200, r#"{"login":"ana-acme"}"#.into()),
        (201, r#"{"number":12,"html_url":"https://github.com/acme/web/issues/12"}"#.into()),
    ])
    .await;
    let c = client().unwrap();
    assert_eq!(verify(&c, &f.endpoints(), Provider::Github, " ghp_tok ", None, None).await.unwrap(), "ana-acme");
    let out = create_issue(&c, &f.endpoints(), Provider::Github, "ghp_tok", &who(Provider::Github), &gh("acme/web"), None).await.unwrap();
    assert_eq!(out, CreatedIssue { key: "acme/web#12".into(), url: "https://github.com/acme/web/issues/12".into(), screenshot: "none" });
    let got = f.got();
    assert_eq!((got[0].method.as_str(), got[0].path.as_str()), ("GET", "/user"));
    assert_eq!(got[0].header("authorization"), "Bearer ghp_tok");
    assert_eq!((got[1].method.as_str(), got[1].path.as_str()), ("POST", "/repos/acme/web/issues"));
    assert_eq!(got[1].header("x-github-api-version"), "2022-11-28");
    assert_eq!(got[1].json(), json!({ "title": "Create a project: step 5 Click Done failed", "body": "**Couldn't find the Done button.**", "labels": ["breakpatch"] }));
}

#[tokio::test]
async fn github_says_plainly_when_the_token_cant_create_issues_there() {
    let f = fake(vec![
        (403, r#"{"message":"Resource not accessible by personal access token"}"#.into()),
        (401, "{}".into()),
        (422, r#"{"message":"Validation Failed","errors":[{"message":"Label does not exist."}]}"#.into()),
        (401, "{}".into()),
    ])
    .await;
    let (c, e, w) = (client().unwrap(), f.endpoints(), who(Provider::Github));
    let err = create_issue(&c, &e, Provider::Github, "t", &w, &gh("acme/web"), None).await.unwrap_err();
    assert!(err.starts_with("GitHub said the token can't create issues in acme/web."), "{err}");
    let err = create_issue(&c, &e, Provider::Github, "t", &w, &gh("acme/web"), None).await.unwrap_err();
    assert!(err.contains("didn't accept the token"), "{err}");
    let err = create_issue(&c, &e, Provider::Github, "t", &w, &gh("acme/web"), None).await.unwrap_err();
    assert_eq!(err, "GitHub didn't take the issue: Label does not exist.");
    let err = verify(&c, &e, Provider::Github, "bad", None, None).await.unwrap_err();
    assert!(err.starts_with("GitHub didn't accept the token"), "{err}");
}

#[tokio::test]
async fn nothing_is_sent_for_a_request_that_doesnt_say_where_it_goes() {
    let f = fake(vec![]).await;
    let c = client().unwrap();
    for repo in ["acme", "acme/web/x", "../etc", "acme/we b"] {
        let err = create_issue(&c, &f.endpoints(), Provider::Github, "t", &who(Provider::Github), &gh(repo), None).await.unwrap_err();
        assert!(err.contains("which GitHub repository"), "{repo}: {err}");
    }
    let mut r = gh("acme/web");
    r.title = " ".into();
    assert!(create_issue(&c, &f.endpoints(), Provider::Github, "t", &who(Provider::Github), &r, None).await.is_err());
    let r = IssueRequest { title: "x".into(), team: Some("EN G".into()), ..Default::default() };
    assert!(create_issue(&c, &f.endpoints(), Provider::Linear, "t", &who(Provider::Linear), &r, None).await.unwrap_err().contains("Linear team"));
    assert!(f.got().is_empty());
}

// ---------------------------------------------------------------- Linear

#[tokio::test]
async fn linear_finds_the_team_uploads_the_screenshot_and_embeds_it() {
    let f = fake(vec![
        (200, r#"{"data":{"teams":{"nodes":[{"id":"team-1","name":"Engineering"}]}}}"#.into()),
        (200, r#"{"data":{"fileUpload":{"success":true,"uploadFile":{"uploadUrl":"{BASE}/upload/shot","assetUrl":"https://uploads.linear.app/a/shot.png","headers":[{"key":"x-goog-meta-id","value":"42"}]}}}}"#.into()),
        (200, String::new()),
        (200, r#"{"data":{"issueCreate":{"success":true,"issue":{"identifier":"ENG-42","url":"https://linear.app/acme/issue/ENG-42"}}}}"#.into()),
    ])
    .await;
    let r = IssueRequest { title: "Sign in failed".into(), body: "Text".into(), team: Some("eng".into()), ..Default::default() };
    let out = create_issue(&client().unwrap(), &f.endpoints(), Provider::Linear, "lin_api_key", &who(Provider::Linear), &r, Some(b"\x89PNG1234".to_vec()))
        .await
        .unwrap();
    assert_eq!(out, CreatedIssue { key: "ENG-42".into(), url: "https://linear.app/acme/issue/ENG-42".into(), screenshot: "attached" });
    let got = f.got();
    assert_eq!(got.len(), 4);
    assert_eq!(got[0].header("authorization"), "lin_api_key", "a personal key goes without Bearer");
    assert_eq!(got[0].json()["variables"], json!({ "key": "eng" }));
    assert_eq!(got[1].json()["variables"], json!({ "size": 8 }));
    assert_eq!((got[2].method.as_str(), got[2].path.as_str()), ("PUT", "/upload/shot"));
    assert_eq!(got[2].header("content-type"), "image/png");
    assert_eq!(got[2].header("x-goog-meta-id"), "42");
    assert_eq!(got[2].header("authorization"), "", "the key never goes to the upload address");
    assert_eq!(got[2].body, b"\x89PNG1234");
    let input = &got[3].json()["variables"]["input"];
    assert_eq!(input["teamId"], "team-1");
    assert_eq!(input["description"], "Text\n![Screenshot](https://uploads.linear.app/a/shot.png)\n");
}

#[tokio::test]
async fn linear_says_when_the_key_or_the_team_is_wrong_and_still_makes_the_issue_when_the_upload_fails() {
    let f = fake(vec![
        (200, r#"{"errors":[{"message":"Authentication required","extensions":{"code":"AUTHENTICATION_ERROR"}}]}"#.into()),
        (200, r#"{"data":{"teams":{"nodes":[]}}}"#.into()),
        (200, r#"{"data":{"teams":{"nodes":[{"id":"t1"}]}}}"#.into()),
        (200, r#"{"data":{"fileUpload":{"success":true,"uploadFile":{"uploadUrl":"ftp://nope","assetUrl":"x","headers":[]}}}}"#.into()),
        (200, r#"{"data":{"issueCreate":{"success":true,"issue":{"identifier":"ENG-7","url":"https://linear.app/i/ENG-7"}}}}"#.into()),
    ])
    .await;
    let (c, e) = (client().unwrap(), f.endpoints());
    assert!(verify(&c, &e, Provider::Linear, "bad", None, None).await.unwrap_err().contains("didn't accept the API key"));
    let r = IssueRequest { title: "T".into(), team: Some("ENG".into()), ..Default::default() };
    assert_eq!(
        create_issue(&c, &e, Provider::Linear, "k", &who(Provider::Linear), &r, None).await.unwrap_err(),
        "Linear has no team ENG that this API key can see."
    );
    let out = create_issue(&c, &e, Provider::Linear, "k", &who(Provider::Linear), &r, Some(vec![1, 2, 3])).await.unwrap();
    assert_eq!((out.key.as_str(), out.screenshot), ("ENG-7", "failed"));
}

// ---------------------------------------------------------------- Jira

#[tokio::test]
async fn jira_uses_basic_auth_creates_the_issue_and_attaches_the_screenshot() {
    let f = fake(vec![
        (200, r#"{"displayName":"Ana Lopez"}"#.into()),
        (201, r#"{"id":"10001","key":"WEB-7"}"#.into()),
        (200, "[]".into()),
    ])
    .await;
    let (c, e) = (client().unwrap(), f.endpoints());
    assert_eq!(verify(&c, &e, Provider::Jira, "atl_tok", Some("ana@acme.com"), Some("https://acme.atlassian.net/jira")).await.unwrap(), "Ana Lopez");
    let r = IssueRequest {
        title: "Checkout failed".into(),
        body: "ignored".into(),
        description: Some(json!({ "type": "doc", "version": 1, "content": [] })),
        project: Some("web".into()),
        issue_type: Some("Task".into()),
        labels: vec!["ui test".into()],
        ..Default::default()
    };
    let out = create_issue(&c, &e, Provider::Jira, "atl_tok", &who(Provider::Jira), &r, Some(b"\x89PNGxyz".to_vec())).await.unwrap();
    assert_eq!(out, CreatedIssue { key: "WEB-7".into(), url: "https://acme.atlassian.net/browse/WEB-7".into(), screenshot: "attached" });
    let got = f.got();
    use base64::Engine as _;
    let basic = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode("ana@acme.com:atl_tok"));
    assert!(got.iter().all(|g| g.header("authorization") == basic));
    assert_eq!(got[0].path, "/rest/api/3/myself");
    assert_eq!(got[1].path, "/rest/api/3/issue");
    assert_eq!(
        got[1].json()["fields"],
        json!({ "project": { "key": "WEB" }, "summary": "Checkout failed", "issuetype": { "name": "Task" },
                "description": { "type": "doc", "version": 1, "content": [] }, "labels": ["ui-test"] })
    );
    assert_eq!(got[2].path, "/rest/api/3/issue/WEB-7/attachments");
    assert_eq!(got[2].header("x-atlassian-token"), "no-check");
    assert!(got[2].header("content-type").starts_with("multipart/form-data; boundary="));
    let body = String::from_utf8_lossy(&got[2].body);
    assert!(body.contains("name=\"file\"; filename=\"screenshot.png\"") && body.contains("PNGxyz"), "{body}");
}

#[tokio::test]
async fn jira_errors_are_plain() {
    let f = fake(vec![
        (403, "{}".into()),
        (400, r#"{"errorMessages":[],"errors":{"issuetype":"Specify a valid issue type"}}"#.into()),
        (404, "{}".into()),
    ])
    .await;
    let (c, e, w) = (client().unwrap(), f.endpoints(), who(Provider::Jira));
    let r = IssueRequest { title: "T".into(), project: Some("WEB".into()), ..Default::default() };
    assert_eq!(create_issue(&c, &e, Provider::Jira, "t", &w, &r, None).await.unwrap_err(), "Jira said ana@acme.com can't create issues in WEB.");
    assert_eq!(create_issue(&c, &e, Provider::Jira, "t", &w, &r, None).await.unwrap_err(), "Jira didn't take the issue: issuetype: Specify a valid issue type");
    assert_eq!(create_issue(&c, &e, Provider::Jira, "t", &w, &r, None).await.unwrap_err(), "Jira has no project WEB, or ana@acme.com can't see it.");
}

#[test]
fn jira_sites_are_atlassian_sites_only() {
    assert_eq!(normalize_site("acme").unwrap(), "acme.atlassian.net");
    assert_eq!(normalize_site(" https://Acme.atlassian.net/jira/software ").unwrap(), "acme.atlassian.net");
    for bad in ["", "evil.example", "acme.atlassian.net.evil.example", "-x.atlassian.net", "a b.atlassian.net", "https://@evil/"] {
        assert!(normalize_site(bad).is_err(), "{bad}");
    }
}

#[test]
fn plain_text_becomes_jira_paragraphs_and_the_attachment_is_one_part() {
    assert_eq!(
        adf_text("One\n\nTwo\n\n"),
        json!({ "type": "doc", "version": 1, "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "One" }] },
            { "type": "paragraph", "content": [{ "type": "text", "text": "Two" }] }] })
    );
    let m = multipart_png(b"abc");
    assert!(m.starts_with(format!("--{BOUNDARY}\r\n").as_bytes()) && m.ends_with(format!("\r\n--{BOUNDARY}--\r\n").as_bytes()));
}

// ---------------------------------------------------------------- tokens on this Mac

#[derive(Default)]
struct MemStore(Mutex<HashMap<String, String>>);
impl SecretStore for MemStore {
    fn get(&self, n: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(n).cloned())
    }
    fn set(&self, n: &str, v: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(n.into(), v.into());
        Ok(())
    }
    fn delete(&self, n: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(n);
        Ok(())
    }
}

#[tokio::test]
async fn a_token_is_kept_only_after_it_works_and_never_in_the_index() {
    let dir = tempfile::tempdir().unwrap();
    let t = Trackers::new(MemStore::default(), dir.path().join("trackers.json"));
    let f = fake(vec![(401, "{}".into()), (200, r#"{"displayName":"Ana"}"#.into())]).await;
    let (c, e) = (client().unwrap(), f.endpoints());
    assert!(save(&t, &c, &e, Provider::Jira, "bad", Some("ana@acme.com".into()), Some("acme".into())).await.is_err());
    assert!(t.status().is_empty());
    let who = save(&t, &c, &e, Provider::Jira, " secret-token ", Some("ana@acme.com".into()), Some("acme".into())).await.unwrap();
    assert_eq!(who, TrackerStatus { provider: Provider::Jira, account: "Ana".into(), site: Some("acme.atlassian.net".into()), email: Some("ana@acme.com".into()) });
    assert_eq!(t.status(), vec![who.clone()]);
    assert_eq!(t.get(Provider::Jira).unwrap(), ("secret-token".to_string(), who));
    let index = fs::read_to_string(dir.path().join("trackers.json")).unwrap();
    assert!(!index.contains("secret-token"));
    assert!(t.get(Provider::Github).unwrap_err().contains("isn't set up on this Mac"));
    t.forget(Provider::Jira).unwrap();
    assert!(t.status().is_empty() && t.store.get("jira").unwrap().is_none());
    assert_eq!(Provider::parse("linear").unwrap(), Provider::Linear);
    assert!(Provider::parse("gitlab").is_err());
}
