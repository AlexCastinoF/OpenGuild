use crate::services::crash_diagnostics::{
    CrashDiagnosticsDump, CrashDiagnosticsService, DiagnosticLevel, DiagnosticSubsystem,
};
use crate::services::device_recovery::{NativeDeviceRecoveryManager, SubsystemId, SubsystemStatus};
use tauri::command;

#[command]
pub fn get_crash_diagnostics() -> CrashDiagnosticsDump {
    CrashDiagnosticsService::global().dump()
}

#[command]
pub fn record_diagnostic_event(
    subsystem: String,
    level: String,
    event_name: String,
    details_json: Option<String>,
) {
    let diag_sub = match subsystem.to_lowercase().as_str() {
        "audiomic" | "mic" => DiagnosticSubsystem::AudioMic,
        "audioheadset" | "headset" | "speaker" => DiagnosticSubsystem::AudioHeadset,
        "wasapi" | "wasapiloopback" => DiagnosticSubsystem::WasapiLoopback,
        "graphics" | "d3d11" => DiagnosticSubsystem::GraphicsContext,
        "wgc" | "framepool" => DiagnosticSubsystem::WgcFramePool,
        "encoder" | "nvenc" => DiagnosticSubsystem::VideoEncoder,
        "lifecycle" => DiagnosticSubsystem::Lifecycle,
        "devicerecovery" | "device" => DiagnosticSubsystem::DeviceRecovery,
        "hardware" => DiagnosticSubsystem::Hardware,
        _ => DiagnosticSubsystem::General,
    };

    let diag_level = match level.to_lowercase().as_str() {
        "debug" => DiagnosticLevel::Debug,
        "warn" | "warning" => DiagnosticLevel::Warn,
        "error" => DiagnosticLevel::Error,
        "fatal" => DiagnosticLevel::Fatal,
        _ => DiagnosticLevel::Info,
    };

    CrashDiagnosticsService::global().record(
        diag_sub,
        diag_level,
        event_name,
        details_json.unwrap_or_default(),
    );
}

#[command]
pub fn clear_crash_diagnostics() {
    CrashDiagnosticsService::global().clear();
}

#[command]
pub fn get_subsystem_health() -> Vec<SubsystemStatus> {
    NativeDeviceRecoveryManager::global().get_all_statuses()
}

#[command]
pub fn trigger_subsystem_recovery(subsystem: String, reason: String) -> Result<(), String> {
    let sub_id = match subsystem.to_lowercase().as_str() {
        "microphone" | "mic" => SubsystemId::Microphone,
        "headset" | "speaker" => SubsystemId::Headset,
        "defaultendpoint" => SubsystemId::DefaultEndpoint,
        "bluetooth" => SubsystemId::Bluetooth,
        "wasapiloopback" | "wasapi" => SubsystemId::WasapiLoopback,
        "graphicscontext" | "graphics" => SubsystemId::GraphicsContext,
        "wgcframepool" | "wgc" => SubsystemId::WgcFramePool,
        "videoencoder" | "encoder" => SubsystemId::VideoEncoder,
        _ => return Err(format!("Unknown subsystem: {}", subsystem)),
    };

    NativeDeviceRecoveryManager::global().trigger_recovery(sub_id, &reason)
}
