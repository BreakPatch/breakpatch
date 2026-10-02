//! The shell's own HTTPS on company networks (Team issue #42).
//!
//! Every client here is reqwest 0.13 with its default features, and so is the updater's
//! (tauri-plugin-updater's defaults): rustls with `rustls-platform-verifier`, which asks the
//! operating system to check each certificate (Security.framework on a Mac, so a company's
//! TLS-inspection root installed in the Keychain is trusted), and `system-proxy`, which takes the
//! Mac's Web Proxy and Secure Web Proxy settings and their bypass list (or HTTPS_PROXY and the
//! like when set). Not a PAC file or WPAD: the manual says what to do then.
//!
//! What's here: telling a certificate the Mac doesn't trust apart from "couldn't reach", so the
//! person gets the sentence that says what to ask IT for.

/// What a TLS-inspecting network looks like from here, in the words the engine uses too.
pub const TLS_INTERCEPTED: &str = "Your network replaced the website's certificate (common on company networks). \
     Breakpatch trusts the certificates your Mac trusts; ask IT to install the network's certificate on this Mac.";

/// Whether `e`, or anything it was caused by, is a certificate this Mac doesn't trust. reqwest's
/// own message ("error sending request") hides the cause; rustls's says "invalid peer certificate".
pub fn is_cert_error(e: &(dyn std::error::Error + 'static)) -> bool {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = cur {
        let text = err.to_string().to_ascii_lowercase();
        if text.contains("invalid peer certificate") || text.contains("certificate verify failed") {
            return true;
        }
        cur = err.source();
    }
    false
}

/// For a host that may have a certificate of its own making (a webhook on an intranet server).
pub fn tls_untrusted(who: &str) -> String {
    format!(
        "This Mac doesn't trust {who}'s certificate. If you're on a company network, it may have replaced the \
         certificate: Breakpatch trusts the certificates your Mac trusts, so ask IT to install the network's \
         certificate on this Mac."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct Wrap(&'static str, Option<Box<dyn std::error::Error + 'static>>);
    impl std::fmt::Display for Wrap {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }
    impl std::error::Error for Wrap {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.1.as_deref()
        }
    }

    #[test]
    fn a_certificate_error_is_found_down_the_chain() {
        let rustls = Wrap("invalid peer certificate: UnknownIssuer", None);
        let io = Wrap("connection error", Some(Box::new(rustls)));
        let top = Wrap("error sending request for url (https://breakpatch.dev/v1/activate)", Some(Box::new(io)));
        assert!(is_cert_error(&top));
        let refused = Wrap("error sending request", Some(Box::new(Wrap("Connection refused (os error 61)", None))));
        assert!(!is_cert_error(&refused));
    }

    #[test]
    fn the_words_say_what_to_ask_it_for() {
        assert!(TLS_INTERCEPTED.starts_with("Your network replaced the website's certificate (common on company networks)."));
        assert!(TLS_INTERCEPTED.ends_with("ask IT to install the network's certificate on this Mac."));
        assert!(tls_untrusted("hooks.acme.com").contains("doesn't trust hooks.acme.com's certificate"));
    }

    /// The real thing: reqwest (the platform verifier) against a local TLS server whose
    /// self-made certificate no store trusts, served by `openssl s_server`.
    #[tokio::test(flavor = "multi_thread")]
    async fn reqwest_reports_an_untrusted_certificate_as_one() {
        let dir = tempfile::tempdir().unwrap();
        let (key, cert) = (dir.path().join("k.pem"), dir.path().join("c.pem"));
        let made = std::process::Command::new("openssl")
            .args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost"])
            .args(["-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout"])
            .arg(&key)
            .arg("-out")
            .arg(&cert)
            .output();
        if !made.is_ok_and(|o| o.status.success()) {
            eprintln!("skipped: no openssl to make a certificate");
            return;
        }
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let mut server = std::process::Command::new("openssl")
            .args(["s_server", "-quiet", "-www", "-accept", &port.to_string(), "-cert"])
            .arg(&cert)
            .arg("-key")
            .arg(&key)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        for _ in 0..50 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let err = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("https://localhost:{port}/"))
            .send()
            .await
            .expect_err("a certificate nobody trusts must fail");
        let _ = server.kill();
        let _ = server.wait();
        assert!(is_cert_error(&err), "not seen as a certificate error: {err:?}");
    }
}
