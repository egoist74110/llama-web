// Bun's Windows module loader fails under write-denying file ACLs. Publish an
// app-owned writable copy; installation stays read-only.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

fn checked_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    if !fs::symlink_metadata(path)?.file_type().is_dir() {
        return Err(io::Error::other("Linked runtime cache is not allowed"));
    }
    Ok(())
}
fn copy_tree(source: &Path, target: &Path) -> io::Result<()> {
    let kind = fs::symlink_metadata(source)?.file_type();
    if kind.is_dir() {
        fs::create_dir(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else if kind.is_file() {
        // CopyFile on Windows preserves the source DACL. Create a new file and
        // stream bytes so it inherits the writable cache directory's permissions.
        let mut input = fs::File::open(source)?;
        let mut output = fs::File::create(target)?;
        io::copy(&mut input, &mut output)?;
        output.sync_all()?;
    } else {
        return Err(io::Error::other("Linked or special bundled resource"));
    }
    Ok(())
}
fn check_tree(path: &Path) -> io::Result<()> {
    let kind = fs::symlink_metadata(path)?.file_type();
    if kind.is_dir() {
        for entry in fs::read_dir(path)? {
            check_tree(&entry?.path())?;
        }
    } else if !kind.is_file() {
        return Err(io::Error::other("Linked or special runtime cache"));
    }
    Ok(())
}
/// `base` is the shell's own short cache directory, independent of the user data path:
/// a deep custom data directory would push sharp's DLL beyond LoadLibrary's legacy path limit.
pub fn writable_resources(resource: &Path, base: &Path) -> Result<PathBuf, String> {
    let result = (|| -> io::Result<PathBuf> {
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(resource.join("versions.json"))?)?;
        let id = manifest["resourceId"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| io::Error::other("Invalid bundled resource identity"))?;
        checked_dir(base)?;
        // This managed directory has one writer: the single-instance shell.
        // A dead shell can leave an unpublished staging tree; never use it as a cache.
        for entry in fs::read_dir(&base)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name
                .strip_prefix(".tmp-")
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
            {
                check_tree(&entry.path())?;
                fs::remove_dir_all(entry.path())?;
            }
        }
        let cache = base.join(&id[..24]);
        if cache.exists() {
            check_tree(&cache)?;
            if fs::read_to_string(cache.join(".resource-id"))? != id
                || !cache.join("app/server/index.mjs").is_file()
                || !cache.join("import-data.mjs").is_file()
            {
                return Err(io::Error::other("Incomplete runtime cache"));
            }
            return Ok(cache);
        }
        let stage = base.join(format!(".tmp-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&stage)?;
        let copied = (|| -> io::Result<()> {
            copy_tree(&resource.join("app"), &stage.join("app"))?;
            copy_tree(
                &resource.join("import-data.mjs"),
                &stage.join("import-data.mjs"),
            )?;
            fs::write(stage.join(".resource-id"), id)?;
            fs::rename(&stage, &cache)
        })();
        if copied.is_err() {
            let _ = fs::remove_dir_all(&stage);
        }
        copied?;
        Ok(cache)
    })();
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publication_is_complete_and_failed_copy_can_retry() {
        let root = std::env::temp_dir().join(format!("desktop-cache-{}", uuid::Uuid::new_v4()));
        let resource = root.join("resource");
        let base = root.join("rc");
        fs::create_dir_all(resource.join("app/server")).unwrap();
        fs::write(
            resource.join("versions.json"),
            serde_json::json!({"resourceId": "a".repeat(64)}).to_string(),
        )
        .unwrap();
        fs::write(resource.join("app/server/index.mjs"), "fixture").unwrap();
        let first = writable_resources(&resource, &base);
        assert!(first.is_err());
        assert_eq!(fs::read_dir(&base).unwrap().count(), 0);
        fs::write(resource.join("import-data.mjs"), "helper").unwrap();
        let leftover = base.join(format!(".tmp-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&leftover).unwrap();
        fs::write(leftover.join("partial"), "incomplete").unwrap();
        let cache = writable_resources(&resource, &base).unwrap();
        assert!(!leftover.exists());
        assert_eq!(
            fs::read_to_string(cache.join("app/server/index.mjs")).unwrap(),
            "fixture"
        );
        assert_eq!(writable_resources(&resource, &base).unwrap(), cache);
        fs::remove_dir_all(root).unwrap();
    }
}
