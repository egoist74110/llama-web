// Application update hand-off. The service downloads and verifies the installer, then asks over
// the private channel; the shell accepts only the current session, a file directly inside
// <data>/run/app-update named like the bundler's installer for the announced version, and the
// SHA-256 it computes itself after the service has stopped. HTTP pages cannot reach this.
use std::{
    fs,
    path::{Path, PathBuf},
};
use windows_sys::Win32::Security::Cryptography::{BCryptHash, BCRYPT_SHA256_ALG_HANDLE};

const PREFIX: &str = "LLAMA_WEB_DESKTOP ";
const MAX_INSTALLER: u64 = 512 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub struct Request {
    pub file: PathBuf,
    pub sha256: String,
    pub version: String,
}

fn valid_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && v.as_bytes()[0].is_ascii_digit()
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// An install request of this session's service, or None.
pub fn request(line: &str, session: &str, pid: u32) -> Option<Request> {
    let msg: serde_json::Value = serde_json::from_str(line.strip_prefix(PREFIX)?).ok()?;
    if msg["version"] != 1
        || msg["session"] != session
        || msg["pid"] != pid
        || msg["type"] != "install"
    {
        return None;
    }
    let sha256 = msg["sha256"]
        .as_str()
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))?
        .to_ascii_lowercase();
    let version = msg["appVersion"].as_str().filter(|v| valid_version(v))?;
    let file = PathBuf::from(msg["file"].as_str()?);
    if !file.is_absolute() {
        return None;
    }
    Some(Request {
        file,
        sha256,
        version: version.into(),
    })
}

pub fn sha256(data: &[u8]) -> Result<String, String> {
    let mut out = [0u8; 32];
    let len = u32::try_from(data.len()).map_err(|_| "Installer too large".to_string())?;
    // SAFETY: input and output buffers are valid for the lengths passed; the pseudo handle needs no cleanup.
    let status = unsafe {
        BCryptHash(
            BCRYPT_SHA256_ALG_HANDLE,
            std::ptr::null(),
            0,
            data.as_ptr(),
            len,
            out.as_mut_ptr(),
            32,
        )
    };
    if status != 0 {
        return Err(format!("BCryptHash failed: {status:#x}"));
    }
    Ok(out.iter().map(|b| format!("{b:02x}")).collect())
}

/// The installer to run: inside `<data_dir>/run/app-update`, the expected name, a plain file, the expected digest.
pub fn verify(req: &Request, data_dir: &Path) -> Result<PathBuf, String> {
    let dir =
        fs::canonicalize(data_dir.join("run").join("app-update")).map_err(|e| e.to_string())?;
    let meta = fs::symlink_metadata(&req.file).map_err(|e| e.to_string())?;
    if !meta.file_type().is_file() || meta.len() > MAX_INSTALLER {
        return Err("Installer is not a plain file of a plausible size".into());
    }
    let file = fs::canonicalize(&req.file).map_err(|e| e.to_string())?;
    if file.parent() != Some(dir.as_path()) {
        return Err("Installer outside the update directory".into());
    }
    let expected = format!("llama-web_{}_x64-setup.exe", req.version);
    if file.file_name().and_then(|n| n.to_str()) != Some(expected.as_str()) {
        return Err("Unexpected installer name".into());
    }
    if sha256(&fs::read(&file).map_err(|e| e.to_string())?)? != req.sha256 {
        return Err("Installer digest mismatch".into());
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn line(session: &str, pid: u32, file: &str, sha: &str, version: &str) -> String {
        format!(
            "{PREFIX}{}",
            serde_json::json!({ "version": 1, "type": "install", "session": session, "pid": pid,
                "file": file, "sha256": sha, "appVersion": version })
        )
    }
    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(
            sha256(b"abc").unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" // pre-commit:allow (public SHA-256 test vector)
        );
    }
    #[test]
    fn request_requires_identity_absolute_path_digest_and_version() {
        let sha = "a".repeat(64);
        let ok = line(
            "s",
            7,
            "C:\\d\\run\\app-update\\x.exe",
            &sha,
            "0.2.0-beta.1",
        );
        assert_eq!(
            request(&ok, "s", 7),
            Some(Request {
                file: "C:\\d\\run\\app-update\\x.exe".into(),
                sha256: sha.clone(),
                version: "0.2.0-beta.1".into()
            })
        );
        assert_eq!(request(&ok, "other", 7), None);
        assert_eq!(request(&ok, "s", 8), None);
        assert_eq!(
            request(&line("s", 7, "relative.exe", &sha, "0.2.0"), "s", 7),
            None
        );
        assert_eq!(
            request(&line("s", 7, "C:\\x.exe", "zz", "0.2.0"), "s", 7),
            None
        );
        assert_eq!(
            request(&line("s", 7, "C:\\x.exe", &sha, "../0"), "s", 7),
            None
        );
        assert_eq!(
            request(&line("s", 7, "C:\\x.exe", &sha, "0 /S"), "s", 7),
            None
        );
    }
    #[test]
    fn verify_accepts_only_the_expected_file_in_the_update_directory() {
        let root = std::env::temp_dir().join(format!("lw-upd-{}", uuid::Uuid::new_v4()));
        let dir = root.join("run").join("app-update");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("llama-web_0.2.0_x64-setup.exe");
        fs::write(&file, b"installer").unwrap();
        let digest = sha256(b"installer").unwrap();
        let req = |file: PathBuf, sha: &str, version: &str| Request {
            file,
            sha256: sha.into(),
            version: version.into(),
        };
        assert!(verify(&req(file.clone(), &digest, "0.2.0"), &root).is_ok());
        assert!(verify(&req(file.clone(), &"0".repeat(64), "0.2.0"), &root).is_err());
        assert!(verify(&req(file.clone(), &digest, "0.3.0"), &root).is_err());
        let outside = root.join("llama-web_0.2.0_x64-setup.exe");
        fs::write(&outside, b"installer").unwrap();
        assert!(verify(&req(outside, &digest, "0.2.0"), &root).is_err());
        let nested = dir.join("sub");
        fs::create_dir_all(&nested).unwrap();
        let deep = nested.join("llama-web_0.2.0_x64-setup.exe");
        fs::write(&deep, b"installer").unwrap();
        assert!(verify(&req(deep, &digest, "0.2.0"), &root).is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}
