use crate::models::RemoteStatus;
use std::path::PathBuf;
use std::process::Command;

pub struct RustdeskService;

impl RustdeskService {
    pub fn get_exe_path() -> Option<PathBuf> {
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let local = PathBuf::from(&local_app_data)
            .join("rustdesk")
            .join("rustdesk.exe");
        if local.exists() {
            return Some(local);
        }

        let program_files =
            std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".to_string());
        let pf = PathBuf::from(&program_files)
            .join("RustDesk")
            .join("rustdesk.exe");
        if pf.exists() {
            return Some(pf);
        }

        let dev_path = PathBuf::from(r"resources\rustdesk\rustdesk.exe");
        if dev_path.exists() {
            return Some(dev_path);
        }

        None
    }

    pub fn read_rustdesk_id() -> Option<String> {
        let app_data = std::env::var("APPDATA").unwrap_or_default();
        let config_paths = [
            PathBuf::from(&app_data)
                .join("RustDesk")
                .join("config")
                .join("RustDesk2.toml"),
            PathBuf::from(&app_data)
                .join("RustDesk")
                .join("config")
                .join("RustDesk.toml"),
        ];

        for path in &config_paths {
            if let Ok(content) = std::fs::read_to_string(path) {
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("id =") || trimmed.starts_with("id=") {
                        let parts: Vec<&str> = trimmed.split('=').collect();
                        if parts.len() >= 2 {
                            let id = parts[1].trim().trim_matches('"').trim_matches('\'');
                            if !id.is_empty() {
                                return Some(id.to_string());
                            }
                        }
                    }
                }
            }
        }
        None
    }

    pub fn status() -> RemoteStatus {
        let exe = Self::get_exe_path();
        let rustdesk_id = Self::read_rustdesk_id();

        RemoteStatus {
            ok: exe.is_some(),
            rustdesk_id,
            error: if exe.is_none() {
                Some("RustDesk binary not found".to_string())
            } else {
                None
            },
            exe: exe.map(|p| p.to_string_lossy().to_string()),
        }
    }

    pub fn connect(host_id: &str, password: Option<&str>) -> Result<(), String> {
        let exe = Self::get_exe_path().ok_or_else(|| "RustDesk não encontrado".to_string())?;
        let mut cmd = Command::new(exe);
        cmd.arg("--connect").arg(host_id);
        if let Some(pwd) = password {
            if !pwd.is_empty() {
                cmd.arg("--password").arg(pwd);
            }
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn kill_all() -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(["/F", "/IM", "rustdesk.exe", "/T"])
                .spawn();
        }
        Ok(())
    }
}
