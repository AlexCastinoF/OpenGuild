use crate::services::performance_guardian::{GuardianStatus, PerformanceGuardianService};
use tauri::{command, State};

#[command]
pub fn get_guardian_status(guardian: State<PerformanceGuardianService>) -> GuardianStatus {
    guardian.get_status()
}

#[command]
pub fn start_guardian(app: tauri::AppHandle, guardian: State<PerformanceGuardianService>) {
    guardian.start(app);
}

#[command]
pub fn stop_guardian(guardian: State<PerformanceGuardianService>) {
    guardian.stop();
}
