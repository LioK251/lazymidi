use crate::commands::{App, Error};
use serde::Deserialize;
use std::{io::Read, time::Duration};
use tauri::Manager;

const LATEST_RELEASE: &str = "https://api.github.com/repos/LioK251/lazymidi/releases/latest";
const RELEASE_PAGE: &str = "https://github.com/LioK251/lazymidi/releases/tag/v";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

fn version_parts(version: &str) -> Option<[u64; 3]> {
    let mut fields = version.split('.');
    let mut parts = [0; 3];
    for part in &mut parts {
        let field = fields.next()?;
        let value = field.parse::<u64>().ok()?;
        if field != value.to_string() {
            return None;
        }
        *part = value;
    }
    fields.next().is_none().then_some(parts)
}

fn available_version(release: &Release, installed: [u64; 3]) -> Option<String> {
    let version = release.tag_name.strip_prefix('v')?;
    (!release.draft && !release.prerelease && version_parts(version)? > installed)
        .then(|| version.to_owned())
}

#[tauri::command]
pub async fn check_for_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Option<String> {
    if window.label() != "main" || app.state::<App>().smoke_path.is_some() {
        return None;
    }
    let version = &app.package_info().version;
    let installed = [version.major, version.minor, version.patch];
    tauri::async_runtime::spawn_blocking(move || {
        let response = reqwest::blocking::Client::builder()
            .user_agent("lazymidi update check")
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .ok()?
            .get(LATEST_RELEASE)
            .send()
            .ok()?
            .error_for_status()
            .ok()?;
        let release = serde_json::from_reader(response.take(1024 * 1024)).ok()?;
        available_version(&release, installed)
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn open_update_release(
    window: tauri::WebviewWindow,
    version: String,
) -> Result<(), Error> {
    if window.label() != "main" || version_parts(&version).is_none() {
        return Err("Invalid update release.".to_string().into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        open::that_detached(format!("{RELEASE_PAGE}{version}"))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| Error::from(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_newer_published_stable_versions_are_offered() {
        let mut release = Release {
            tag_name: "v0.2.10".into(),
            draft: false,
            prerelease: false,
        };
        assert_eq!(
            available_version(&release, [0, 2, 2]).as_deref(),
            Some("0.2.10")
        );
        assert!(available_version(&release, [0, 2, 10]).is_none());
        assert!(available_version(&release, [0, 3, 0]).is_none());
        release.prerelease = true;
        assert!(available_version(&release, [0, 2, 2]).is_none());
        release.prerelease = false;
        release.draft = true;
        assert!(available_version(&release, [0, 2, 2]).is_none());
        for invalid in ["0.2.03", "1.2.3-rc.1", "1.2", "1.2.3/extra", "1.+2.3"] {
            assert!(version_parts(invalid).is_none(), "{invalid}");
        }
    }
}
