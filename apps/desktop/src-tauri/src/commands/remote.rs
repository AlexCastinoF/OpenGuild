use crate::models::RemoteStatus;
use crate::services::RustdeskService;

#[tauri::command]
pub fn remote_status() -> RemoteStatus {
    RustdeskService::status()
}

#[tauri::command]
pub fn remote_prepare_host(_opts: serde_json::Value) -> Result<serde_json::Value, String> {
    let id = RustdeskService::read_rustdesk_id().unwrap_or_default();
    Ok(serde_json::json!({
        "ok": true,
        "rustdesk_id": id,
    }))
}

#[tauri::command]
pub fn remote_connect(opts: serde_json::Value) -> Result<serde_json::Value, String> {
    let host_id = opts.get("host_id").and_then(|v| v.as_str()).unwrap_or_default();
    let password = opts.get("password").and_then(|v| v.as_str());

    RustdeskService::connect(host_id, password)?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn remote_end() -> Result<serde_json::Value, String> {
    RustdeskService::kill_all()?;
    Ok(serde_json::json!({ "ok": true }))
}
