use crate::models::{
    AppSettings, AuthResponse, ConfigResponse, GpuCapabilitiesResponse, UpdateStatus, UserCreds,
};
use crate::services::{GpuService, StorageService};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn get_config() -> ConfigResponse {
    let server_url = std::env::var("SF_COMMUNITY_URL")
        .or_else(|_| std::env::var("RALLYDESK_URL"))
        .or_else(|_| std::env::var("STEAMFARM_URL"))
        .unwrap_or_else(|_| "http://localhost:5174".to_string());

    ConfigResponse {
        server_url,
        desktop: true,
        version: "1.2.43".to_string(),
        is_dev: cfg!(debug_assertions),
    }
}

#[tauri::command]
pub fn get_settings() -> AppSettings {
    StorageService::load_settings()
}

#[tauri::command]
pub fn set_settings(partial: serde_json::Value) -> Result<AppSettings, String> {
    StorageService::save_settings(partial).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_saved_creds() -> Option<UserCreds> {
    StorageService::get_saved_creds()
}

#[tauri::command]
pub fn save_creds(username: String, password: String) -> Result<(), String> {
    StorageService::save_creds(&username, &password).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_creds() -> Result<(), String> {
    StorageService::clear_creds().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn auth_status() -> AuthResponse {
    let creds = StorageService::get_saved_creds();
    let username = creds.map(|c| c.username).unwrap_or_else(|| "admin".to_string());
    AuthResponse {
        ok: true,
        status: Some(200),
        user: Some(serde_json::json!({
            "id": 1,
            "username": username,
            "label": "Admin Teste",
            "avatar_url": "",
            "is_super": true,
            "premium_themes": true
        })),
        error: None,
    }
}

#[tauri::command]
pub fn login(username: String, password: String, remember: bool) -> AuthResponse {
    if remember {
        let _ = StorageService::save_creds(&username, &password);
    }
    AuthResponse {
        ok: true,
        status: Some(200),
        user: Some(serde_json::json!({
            "id": 1,
            "username": username,
            "label": if username == "admin" { "Admin Teste".to_string() } else { username.clone() },
            "avatar_url": "",
            "is_super": true,
            "premium_themes": true
        })),
        error: None,
    }
}

#[tauri::command]
pub fn register_send_code(_phone: Option<String>) -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": "use_web_register" })
}

#[tauri::command]
pub fn register(_payload: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub fn logout() -> Result<(), String> {
    let _ = StorageService::clear_creds();
    Ok(())
}

#[tauri::command]
pub fn open_register(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval("window.location.href = '/register';");
    }
    Ok(())
}

#[tauri::command]
pub fn open_login(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval("window.location.href = '/login';");
    }
    Ok(())
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_update_status() -> UpdateStatus {
    UpdateStatus {
        available: false,
        ready: false,
        downloading: false,
        version: None,
    }
}

#[tauri::command]
pub fn prompt_install_update() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn get_gpu_capabilities() -> GpuCapabilitiesResponse {
    GpuService::get_capabilities()
}
