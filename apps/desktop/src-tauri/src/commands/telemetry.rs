use crate::services::{HardwareTelemetry, TelemetryService};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn get_hardware_telemetry(
    telemetry: State<TelemetryService>,
) -> Result<HardwareTelemetry, String> {
    Ok(telemetry.get_latest())
}

#[tauri::command]
pub fn start_hardware_telemetry(
    app: AppHandle,
    telemetry: State<TelemetryService>,
) -> Result<serde_json::Value, String> {
    telemetry.start(app);
    Ok(serde_json::json!({ "ok": true, "sampling": true }))
}

#[tauri::command]
pub fn stop_hardware_telemetry(
    telemetry: State<TelemetryService>,
) -> Result<serde_json::Value, String> {
    telemetry.stop();
    Ok(serde_json::json!({ "ok": true, "sampling": false }))
}
