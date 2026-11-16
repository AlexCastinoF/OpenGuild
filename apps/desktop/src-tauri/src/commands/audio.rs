use crate::services::AudioService;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn start_game_audio(app: AppHandle, audio_service: State<AudioService>) -> Result<serde_json::Value, String> {
    audio_service.start_game_audio(&app)?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn start_system_audio(app: AppHandle, audio_service: State<AudioService>) -> Result<serde_json::Value, String> {
    audio_service.start_system_audio(&app)?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn stop_game_audio(audio_service: State<AudioService>) -> Result<serde_json::Value, String> {
    audio_service.stop_game_audio()?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn get_audio_routing_status(audio_service: State<AudioService>) -> Result<serde_json::Value, String> {
    let status = audio_service.get_status();
    Ok(serde_json::to_value(status).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub fn set_share_audio_mode(mode: String, audio_service: State<AudioService>) -> Result<serde_json::Value, String> {
    audio_service.set_audio_mode(&mode);
    Ok(serde_json::json!({ "ok": true, "mode": mode }))
}

#[tauri::command]
pub fn set_share_capture_prefs(prefs: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "prefs": prefs }))
}

#[tauri::command]
pub fn set_share_active(active: bool, audio_service: State<AudioService>) -> Result<serde_json::Value, String> {
    audio_service.set_share_active(active);
    Ok(serde_json::json!({ "ok": true, "shareActive": active }))
}

#[tauri::command]
pub fn ensure_speakers_unmuted() -> Result<serde_json::Value, String> {
    AudioService::ensure_speakers_unmuted()?;
    Ok(serde_json::json!({ "ok": true }))
}
