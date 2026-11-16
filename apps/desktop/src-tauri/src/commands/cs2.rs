use crate::models::GsiStatusResponse;
use crate::services::{Cs2Service, GsiService};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn match_prepare_host(opts: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "dedicated": true,
        "phase": "ready",
        "port": opts.get("port").and_then(|v| v.as_u64()).unwrap_or(27015),
        "map": opts.get("map").and_then(|v| v.as_str()).unwrap_or("de_mirage"),
        "upnpOk": true,
    }))
}

#[tauri::command]
pub fn match_ensure_pack(version: serde_json::Value) -> Result<serde_json::Value, String> {
    let ver = version.as_str().unwrap_or("latest");
    Ok(serde_json::json!({
        "ok": true,
        "version": ver,
        "cached": true,
    }))
}

#[tauri::command]
pub fn match_list_installed_packs() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "versions": ["1.0.0"],
        "active": "1.0.0",
    }))
}

#[tauri::command]
pub fn match_open_tunnel(opts: serde_json::Value) -> Result<serde_json::Value, String> {
    let port = opts.get("localPort").and_then(|v| v.as_u64()).unwrap_or(27015);
    Ok(serde_json::json!({
        "ok": true,
        "publicPort": port,
        "via": "upnp",
    }))
}

#[tauri::command]
pub fn match_connect(opts: serde_json::Value) -> Result<serde_json::Value, String> {
    let host = opts.get("host").and_then(|v| v.as_str()).unwrap_or("127.0.0.1");
    let port = opts.get("port").and_then(|v| v.as_u64()).unwrap_or(27015) as u16;
    let password = opts.get("password").and_then(|v| v.as_str());

    Cs2Service::connect_game(host, port, password)?;
    Ok(serde_json::json!({
        "ok": true,
        "steamLaunch": true,
    }))
}

#[tauri::command]
pub fn match_open_cs2() -> Result<serde_json::Value, String> {
    Cs2Service::open_cs2()?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn match_dedicated_status(cs2: State<Cs2Service>) -> Result<serde_json::Value, String> {
    let running = cs2.is_dedicated_running();
    Ok(serde_json::json!({
        "ok": true,
        "running": running,
    }))
}

#[tauri::command]
pub fn match_dedicated_stop(cs2: State<Cs2Service>) -> Result<serde_json::Value, String> {
    cs2.stop_dedicated()?;
    Ok(serde_json::json!({ "ok": true, "stopped": true }))
}

#[tauri::command]
pub fn match_dedicated_snapshot(cs2: State<Cs2Service>) -> Result<serde_json::Value, String> {
    let running = cs2.is_dedicated_running();
    Ok(serde_json::json!({
        "ok": true,
        "running": running,
        "playersInServer": [],
    }))
}

#[tauri::command]
pub fn match_dedicated_exec(cmd: String) -> Result<serde_json::Value, String> {
    log::info!("[CS2 Exec] {}", cmd);
    Ok(serde_json::json!({ "ok": true, "cmd": cmd }))
}

#[tauri::command]
pub fn match_rewrite_teams(players: serde_json::Value) -> Result<serde_json::Value, String> {
    let count = players.as_array().map(|a| a.len()).unwrap_or(0);
    Ok(serde_json::json!({ "ok": true, "count": count }))
}

#[tauri::command]
pub fn match_admin_settings(settings: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "settings": settings }))
}

#[tauri::command]
pub fn match_sound_settings(settings: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "settings": settings }))
}

#[tauri::command]
pub fn match_sound_prefs_get() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "settings": {} }))
}

#[tauri::command]
pub fn match_admin_bots(action: String) -> Result<serde_json::Value, String> {
    log::info!("[CS2 Bots] Action: {}", action);
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn match_gslt_get() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "hasToken": false }))
}

#[tauri::command]
pub fn match_gslt_set(token: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "hasToken": !token.is_empty() }))
}

#[tauri::command]
pub fn match_console_key_get() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "configured": true,
        "consoleVk": 192,
    }))
}

#[tauri::command]
pub fn match_console_key_set(vk: u32) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "consoleVk": vk }))
}

#[tauri::command]
pub fn match_history_list(_opts: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "matches": [] }))
}

#[tauri::command]
pub fn match_history_push(entry: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "match": entry }))
}

#[tauri::command]
pub fn match_history_clear() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true }))
}

// CS2 Game State Integration (GSI)
#[tauri::command]
pub fn gsi_status(gsi: State<GsiService>) -> GsiStatusResponse {
    gsi.status()
}

#[tauri::command]
pub fn gsi_enable(app: AppHandle, gsi: State<GsiService>) -> Result<serde_json::Value, String> {
    gsi.start(app)?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn gsi_redeploy(app: AppHandle, gsi: State<GsiService>) -> Result<serde_json::Value, String> {
    gsi.start(app)?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn gsi_disable(gsi: State<GsiService>) -> Result<serde_json::Value, String> {
    gsi.stop();
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn gsi_detect() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn gsi_history(_opts: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "matches": [] }))
}

#[tauri::command]
pub fn gsi_history_get(id: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "id": id, "match": null }))
}

#[tauri::command]
pub fn gsi_history_clear() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn gsi_history_merge_valve(match_id: String, valve: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "matchId": match_id, "valve": valve }))
}
