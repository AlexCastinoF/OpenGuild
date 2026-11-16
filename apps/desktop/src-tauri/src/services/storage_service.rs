use crate::errors::AppError;
use crate::models::{AppSettings, UserCreds};
use std::fs;
use std::path::PathBuf;

pub struct StorageService;

#[cfg(target_os = "windows")]
#[repr(C)]
struct DataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

#[cfg(target_os = "windows")]
#[link(name = "crypt32")]
unsafe extern "system" {
    fn CryptProtectData(
        p_data_in: *const DataBlob,
        sz_data_descr: *const u16,
        p_optional_entropy: *const DataBlob,
        pv_reserved: *mut std::ffi::c_void,
        p_prompt_struct: *mut std::ffi::c_void,
        dw_flags: u32,
        p_data_out: *mut DataBlob,
    ) -> i32;

    fn CryptUnprotectData(
        p_data_in: *const DataBlob,
        ppsz_data_descr: *mut *mut u16,
        p_optional_entropy: *const DataBlob,
        pv_reserved: *mut std::ffi::c_void,
        p_prompt_struct: *mut std::ffi::c_void,
        dw_flags: u32,
        p_data_out: *mut DataBlob,
    ) -> i32;
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LocalFree(h_mem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

impl StorageService {
    pub fn get_user_data_dir() -> PathBuf {
        let app_data = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
        let dir = PathBuf::from(&app_data).join("RallyDesk-localdev");
        if !dir.exists() {
            let legacy_dir = PathBuf::from(&app_data).join("SteamFarm-Comunidade-localdev");
            if legacy_dir.exists() {
                let _ = fs::create_dir_all(&dir);
                let _ = fs::copy(legacy_dir.join("settings.json"), dir.join("settings.json"));
                let _ = fs::copy(legacy_dir.join("auth.dat"), dir.join("auth.dat"));
            }
        }
        let _ = fs::create_dir_all(&dir);
        dir
    }

    pub fn get_settings_path() -> PathBuf {
        Self::get_user_data_dir().join("settings.json")
    }

    pub fn get_creds_path() -> PathBuf {
        Self::get_user_data_dir().join("auth.dat")
    }

    pub fn load_settings() -> AppSettings {
        let path = Self::get_settings_path();
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(settings) = serde_json::from_str::<AppSettings>(&content) {
                return settings;
            }
        }
        AppSettings::default()
    }

    pub fn save_settings(partial: serde_json::Value) -> Result<AppSettings, AppError> {
        let mut current = Self::load_settings();
        if let Some(obj) = partial.as_object() {
            if let Some(v) = obj.get("minimizeToTray").and_then(|v| v.as_bool()) {
                current.minimize_to_tray = v;
            }
            if let Some(v) = obj.get("openAtLogin").and_then(|v| v.as_bool()) {
                current.open_at_login = v;
            }
            if let Some(v) = obj.get("communityUrl").and_then(|v| v.as_str()) {
                current.community_url = Some(v.to_string());
            }
        }
        let serialized = serde_json::to_string_pretty(&current)?;
        fs::write(Self::get_settings_path(), serialized)?;
        Ok(current)
    }

    pub fn encrypt_bytes(data: &[u8]) -> Result<Vec<u8>, AppError> {
        #[cfg(target_os = "windows")]
        unsafe {
            let in_blob = DataBlob {
                cb_data: data.len() as u32,
                pb_data: data.as_ptr() as *mut u8,
            };
            let mut out_blob = DataBlob {
                cb_data: 0,
                pb_data: std::ptr::null_mut(),
            };

            let res = CryptProtectData(
                &in_blob,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                &mut out_blob,
            );

            if res == 0 || out_blob.pb_data.is_null() {
                return Err(AppError::from("CryptProtectData failed"));
            }

            let slice = std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize);
            let result = slice.to_vec();
            LocalFree(out_blob.pb_data as *mut std::ffi::c_void);
            Ok(result)
        }

        #[cfg(not(target_os = "windows"))]
        {
            Ok(data.to_vec())
        }
    }

    pub fn decrypt_bytes(encrypted: &[u8]) -> Result<Vec<u8>, AppError> {
        #[cfg(target_os = "windows")]
        unsafe {
            let in_blob = DataBlob {
                cb_data: encrypted.len() as u32,
                pb_data: encrypted.as_ptr() as *mut u8,
            };
            let mut out_blob = DataBlob {
                cb_data: 0,
                pb_data: std::ptr::null_mut(),
            };

            let res = CryptUnprotectData(
                &in_blob,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                &mut out_blob,
            );

            if res == 0 || out_blob.pb_data.is_null() {
                return Err(AppError::from("CryptUnprotectData failed"));
            }

            let slice = std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize);
            let result = slice.to_vec();
            LocalFree(out_blob.pb_data as *mut std::ffi::c_void);
            Ok(result)
        }

        #[cfg(not(target_os = "windows"))]
        {
            Ok(encrypted.to_vec())
        }
    }

    pub fn save_creds(username: &str, password: &str) -> Result<(), AppError> {
        let creds = UserCreds {
            username: username.to_string(),
            password: password.to_string(),
        };
        let json = serde_json::to_string(&creds)?;
        let encrypted = Self::encrypt_bytes(json.as_bytes())?;
        fs::write(Self::get_creds_path(), encrypted)?;
        Ok(())
    }

    pub fn get_saved_creds() -> Option<UserCreds> {
        let path = Self::get_creds_path();
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(decrypted) = Self::decrypt_bytes(&bytes) {
                if let Ok(creds) = serde_json::from_slice::<UserCreds>(&decrypted) {
                    return Some(creds);
                }
            }
        }
        None
    }

    pub fn clear_creds() -> Result<(), AppError> {
        let path = Self::get_creds_path();
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }
}
