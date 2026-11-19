//! Where the installed app keeps its data, and how to point it elsewhere.
//!
//! By default the sidecar uses `~/.nexux/nexux.db` and `~/.nexux`. A file at
//! `~/.nexux/native.json` can point either somewhere else — typically at the
//! dev server's database, so the packaged app runs against the same projects,
//! credentials and settings as `pnpm dev`:
//!
//! ```json
//! { "databasePath": "~/workspace/nexux/apps/web/data/dashboard.db" }
//! ```
//!
//! The file lives at a fixed place (`~/.nexux`) because it is what says where
//! everything else is. A GUI app launched from Finder or the Start menu gets
//! no shell environment, so an env var could not do this job.

use serde::Deserialize;
use std::path::{Path, PathBuf};

pub const CONFIG_FILE: &str = "native.json";

#[derive(Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeConfigFile {
    pub database_path: Option<String>,
    pub data_dir: Option<String>,
}

#[derive(Debug, PartialEq)]
pub struct ResolvedPaths {
    pub database_path: PathBuf,
    pub data_dir: PathBuf,
    /// True when native.json changed anything — worth a line in the log.
    pub overridden: bool,
}

/// `~/x` → `<home>/x`. Anything else is returned as written.
fn expand_home(raw: &str, home: &Path) -> PathBuf {
    if raw == "~" {
        return home.to_path_buf();
    }
    match raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        Some(rest) => home.join(rest),
        None => PathBuf::from(raw),
    }
}

fn absolute(field: &str, raw: &str, home: &Path) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(format!("{CONFIG_FILE}: \"{field}\" is empty"));
    }
    let path = expand_home(raw, home);
    // Relative to what? The app's working directory is wherever the OS
    // launched it from — refuse rather than resolve against that.
    if !path.is_absolute() {
        return Err(format!(
            "{CONFIG_FILE}: \"{field}\" must be an absolute path (or start with ~/), got \"{raw}\""
        ));
    }
    Ok(path)
}

/// Resolve the sidecar's paths from the contents of native.json, if any.
/// `None` (no file) is the default layout under `bootstrap_dir`.
pub fn resolve(
    contents: Option<&str>,
    bootstrap_dir: &Path,
    home: &Path,
) -> Result<ResolvedPaths, String> {
    let file: NativeConfigFile = match contents {
        None => NativeConfigFile::default(),
        Some(text) => serde_json::from_str(text)
            .map_err(|e| format!("{CONFIG_FILE} is not valid: {e}"))?,
    };

    let data_dir = match &file.data_dir {
        Some(raw) => absolute("dataDir", raw, home)?,
        None => bootstrap_dir.to_path_buf(),
    };
    let database_path = match &file.database_path {
        Some(raw) => absolute("databasePath", raw, home)?,
        None => data_dir.join("nexux.db"),
    };
    // A database path that points at a directory is a typo that would
    // otherwise surface as an opaque SQLite error inside the sidecar.
    if database_path.is_dir() {
        return Err(format!(
            "{CONFIG_FILE}: \"databasePath\" is a directory — point it at the .db file ({})",
            database_path.to_string_lossy()
        ));
    }

    Ok(ResolvedPaths {
        overridden: file != NativeConfigFile::default(),
        database_path,
        data_dir,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/Users/me")
    }
    fn boot() -> PathBuf {
        home().join(".nexux")
    }

    #[test]
    fn no_file_is_the_default_layout() {
        let r = resolve(None, &boot(), &home()).unwrap();
        assert_eq!(r.data_dir, boot());
        assert_eq!(r.database_path, boot().join("nexux.db"));
        assert!(!r.overridden);
    }

    #[test]
    fn database_path_points_at_the_dev_database() {
        let r = resolve(
            Some(r#"{ "databasePath": "~/ws/nexus/apps/web/data/dashboard.db" }"#),
            &boot(),
            &home(),
        )
        .unwrap();
        assert_eq!(r.database_path, home().join("ws/nexus/apps/web/data/dashboard.db"));
        // The data dir stays where the dev server keeps it too.
        assert_eq!(r.data_dir, boot());
        assert!(r.overridden);
    }

    #[test]
    fn data_dir_moves_the_default_database_with_it() {
        let r = resolve(Some(r#"{ "dataDir": "/srv/nexux" }"#), &boot(), &home()).unwrap();
        assert_eq!(r.data_dir, PathBuf::from("/srv/nexux"));
        assert_eq!(r.database_path, PathBuf::from("/srv/nexux/nexux.db"));
    }

    #[test]
    fn relative_paths_are_refused() {
        let err = resolve(Some(r#"{ "databasePath": "data/dashboard.db" }"#), &boot(), &home())
            .unwrap_err();
        assert!(err.contains("must be an absolute path"), "{err}");
    }

    #[test]
    fn typos_are_refused_not_ignored() {
        // A misspelt key silently falling back to the default database is the
        // one failure that looks like success.
        let err = resolve(Some(r#"{ "databasePth": "/x.db" }"#), &boot(), &home()).unwrap_err();
        assert!(err.contains("not valid"), "{err}");
        assert!(resolve(Some("{ nope"), &boot(), &home()).is_err());
        assert!(resolve(Some(r#"{ "databasePath": "  " }"#), &boot(), &home()).is_err());
    }

    #[test]
    fn a_directory_is_not_a_database() {
        let dir = std::env::temp_dir();
        let json = format!(r#"{{ "databasePath": {:?} }}"#, dir.to_string_lossy());
        let err = resolve(Some(&json), &boot(), &home()).unwrap_err();
        assert!(err.contains("is a directory"), "{err}");
    }
}
