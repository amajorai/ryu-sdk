//! Core-compatible data-directory resolution for the SDK's disk helpers.
//!
//! This mirrors Core's bootstrap contract (`RYU_DIR` > the Storage pointer file >
//! `~/.ryu<profile suffix>`) without depending on Core-internal crates, so
//! `ryu-sdk` stays publishable on its own and every binding (napi, uniffi, ffi)
//! can call it from a host process.
//!
//! Unlike Core, resolution never panics or fails: the SDK runs inside foreign
//! hosts where a panic would abort the process or unwind across FFI. An unknown
//! `RYU_PROFILE` (which Core itself refuses to boot with) falls back to the
//! release layout, and an unreadable or corrupt pointer file falls back to the
//! profile default, matching Core's ordinary boot path.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};

const RYU_DIR_ENV: &str = "RYU_DIR";
const RYU_PROFILE_ENV: &str = "RYU_PROFILE";
const POINTER_FILE_NAME: &str = "data-path.json";
/// Same cap Core applies when reading the pointer file.
const POINTER_MAX_BYTES: u64 = 128 * 1024;
/// Non-release profiles Core knows. Each gets a `-<profile>` suffix.
const SUFFIXED_PROFILES: &[&str] = &["dev", "canary", "nightly", "beta"];

#[derive(Debug, Default, serde::Deserialize)]
struct DataPathPointer {
    #[serde(default)]
    data_dir: Option<String>,
}

/// The data/config suffix for a raw `RYU_PROFILE` value: `""` for release (or an
/// unset, empty, or unknown profile) and `-<profile>` for a known one.
fn profile_suffix(raw_profile: Option<&str>) -> String {
    let profile = raw_profile
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if SUFFIXED_PROFILES.contains(&profile.as_str()) {
        format!("-{profile}")
    } else {
        String::new()
    }
}

fn read_pointer(pointer_path: &Path) -> Option<PathBuf> {
    let file = std::fs::File::open(pointer_path).ok()?;
    let mut bytes = Vec::new();
    file.take(POINTER_MAX_BYTES).read_to_end(&mut bytes).ok()?;
    serde_json::from_slice::<DataPathPointer>(&bytes)
        .ok()?
        .data_dir
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

/// Pure resolution over explicit inputs, so tests never mutate process env.
fn resolve(
    override_dir: Option<OsString>,
    raw_profile: Option<&str>,
    home: Option<PathBuf>,
    os_config: Option<PathBuf>,
) -> PathBuf {
    if let Some(path) = override_dir.filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
    }
    let suffix = profile_suffix(raw_profile);
    let default_data_dir = home
        .unwrap_or_else(|| PathBuf::from("."))
        .join(format!(".ryu{suffix}"));
    let pointer_path = os_config
        .unwrap_or_else(|| default_data_dir.clone())
        .join(format!("ryu{suffix}"))
        .join(POINTER_FILE_NAME);
    read_pointer(&pointer_path).unwrap_or(default_data_dir)
}

/// The active Ryu data directory, resolved from the current environment on
/// every call (no process-lifetime cache).
pub(crate) fn ryu_dir() -> PathBuf {
    let profile = std::env::var(RYU_PROFILE_ENV).ok();
    resolve(
        std::env::var_os(RYU_DIR_ENV),
        profile.as_deref(),
        dirs::home_dir(),
        dirs::config_dir(),
    )
}

/// The installed-plugins folder under the data dir.
const PLUGINS_DIR_NAME: &str = "plugins";

/// `<root>/plugins`: installed plugin packages. The SDK's copy of
/// `ryu_sidecar_runtime::layout::plugins_dir`, which it cannot depend on
/// because that crate is not published; keep the two in step.
pub(crate) fn plugins_dir(root: &Path) -> PathBuf {
    root.join(PLUGINS_DIR_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ryu-sdk-data-dir-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unknown_profile_falls_back_to_release_without_panicking() {
        let home = PathBuf::from("home");
        let config = PathBuf::from("config-does-not-exist");
        for profile in ["staging", "../escape", "Release", "", "  "] {
            assert_eq!(
                resolve(
                    None,
                    Some(profile),
                    Some(home.clone()),
                    Some(config.clone())
                ),
                home.join(".ryu"),
                "profile {profile:?} should resolve to the release layout"
            );
        }
        assert_eq!(
            resolve(None, None, Some(home.clone()), Some(config)),
            home.join(".ryu")
        );
    }

    #[test]
    fn known_profiles_are_suffixed_case_insensitively() {
        let home = PathBuf::from("home");
        let config = PathBuf::from("config-does-not-exist");
        for (raw, expected) in [
            ("dev", ".ryu-dev"),
            (" DEV ", ".ryu-dev"),
            ("canary", ".ryu-canary"),
            ("nightly", ".ryu-nightly"),
            ("beta", ".ryu-beta"),
        ] {
            assert_eq!(
                resolve(None, Some(raw), Some(home.clone()), Some(config.clone())),
                home.join(expected)
            );
        }
    }

    #[test]
    fn explicit_ryu_dir_wins_and_empty_is_ignored() {
        let explicit = PathBuf::from("explicit-data");
        assert_eq!(
            resolve(
                Some(explicit.clone().into_os_string()),
                Some("dev"),
                Some(PathBuf::from("home")),
                None
            ),
            explicit
        );
        assert_eq!(
            resolve(
                Some(OsString::new()),
                Some("dev"),
                Some(PathBuf::from("home")),
                Some(PathBuf::from("config-does-not-exist"))
            ),
            PathBuf::from("home").join(".ryu-dev")
        );
    }

    #[test]
    fn storage_pointer_wins_over_the_default_and_bad_pointers_are_ignored() {
        let root = scratch("pointer");
        let home = root.join("home");
        let config = root.join("config");
        let pointer_dir = config.join("ryu-dev");
        std::fs::create_dir_all(&pointer_dir).unwrap();
        let pointer = pointer_dir.join(POINTER_FILE_NAME);
        let relocated = root.join("relocated");
        std::fs::write(
            &pointer,
            serde_json::json!({ "data_dir": relocated.to_string_lossy() }).to_string(),
        )
        .unwrap();
        assert_eq!(
            resolve(None, Some("dev"), Some(home.clone()), Some(config.clone())),
            relocated
        );
        // The pointer is profile-scoped: release does not read dev's pointer.
        assert_eq!(
            resolve(
                None,
                Some("release"),
                Some(home.clone()),
                Some(config.clone())
            ),
            home.join(".ryu")
        );
        for bad in [
            "{",
            "null",
            "{\"data_dir\":42}",
            "{\"data_dir\":\"\"}",
            "{}",
        ] {
            std::fs::write(&pointer, bad).unwrap();
            assert_eq!(
                resolve(None, Some("dev"), Some(home.clone()), Some(config.clone())),
                home.join(".ryu-dev"),
                "pointer {bad:?} should fall back to the profile default"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_config_dir_reads_the_pointer_under_the_default_data_dir() {
        let root = scratch("no-config");
        let home = root.join("home");
        let pointer_dir = home.join(".ryu").join("ryu");
        std::fs::create_dir_all(&pointer_dir).unwrap();
        let relocated = root.join("elsewhere");
        std::fs::write(
            pointer_dir.join(POINTER_FILE_NAME),
            serde_json::json!({ "data_dir": relocated.to_string_lossy() }).to_string(),
        )
        .unwrap();
        assert_eq!(resolve(None, None, Some(home), None), relocated);
        let _ = std::fs::remove_dir_all(&root);
    }
}
