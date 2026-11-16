use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigResponse {
    pub server_url: String,
    pub desktop: bool,
    pub version: String,
    pub is_dev: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppSettings {
    #[serde(rename = "minimizeToTray", default)]
    pub minimize_to_tray: bool,
    #[serde(rename = "openAtLogin", default)]
    pub open_at_login: bool,
    #[serde(rename = "communityUrl", default)]
    pub community_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserCreds {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    pub ok: bool,
    pub status: Option<u16>,
    pub user: Option<serde_json::Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateStatus {
    pub available: bool,
    pub ready: bool,
    pub downloading: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteStatus {
    pub ok: bool,
    pub rustdesk_id: Option<String>,
    pub error: Option<String>,
    pub exe: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GsiStatusResponse {
    pub ok: bool,
    pub enabled: bool,
    pub listening: bool,
    pub port: u16,
    pub auth_configured: bool,
    pub receiving: bool,
    pub waiting: bool,
    pub error: String,
    pub snapshot: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureSource {
    pub id: String,
    pub name: String,
    #[serde(rename = "thumbnailDataUrl")]
    pub thumbnail_data_url: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuInfo {
    pub name: String,
    pub vendor: String,
    #[serde(rename = "vendorId")]
    pub vendor_id: String,
    #[serde(rename = "driverVersion")]
    pub driver_version: String,
    #[serde(rename = "dedicatedVramMb")]
    pub dedicated_vram_mb: u64,
    #[serde(rename = "isIntegrated")]
    pub is_integrated: bool,
    pub architecture: String,
    #[serde(rename = "encoderTier")]
    pub encoder_tier: String,
    #[serde(rename = "maxRecommendedResolution")]
    pub max_recommended_resolution: String,
    #[serde(rename = "maxRecommendedFps")]
    pub max_recommended_fps: u32,
    #[serde(rename = "recommendedPreset")]
    pub recommended_preset: String,
    #[serde(rename = "recommendedCodec")]
    pub recommended_codec: String,
    #[serde(rename = "av1EncodeSupported")]
    pub av1_encode_supported: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuCapabilitiesResponse {
    pub ok: bool,
    #[serde(rename = "primaryGpu")]
    pub primary_gpu: GpuInfo,
    #[serde(rename = "allGpus")]
    pub all_gpus: Vec<GpuInfo>,
    #[serde(rename = "osVersion")]
    pub os_version: String,
    #[serde(rename = "wgcSupported")]
    pub wgc_supported: bool,
    #[serde(rename = "zeroCopySupported")]
    pub zero_copy_supported: bool,
}
