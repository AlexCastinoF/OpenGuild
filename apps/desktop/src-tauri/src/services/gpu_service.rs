use crate::models::{GpuCapabilitiesResponse, GpuInfo};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct GpuService;

impl GpuService {
    pub fn get_capabilities() -> GpuCapabilitiesResponse {
        #[cfg(target_os = "windows")]
        {
            Self::detect_windows_gpus()
        }

        #[cfg(not(target_os = "windows"))]
        {
            Self::fallback_response()
        }
    }

    #[cfg(target_os = "windows")]
    fn detect_windows_gpus() -> GpuCapabilitiesResponse {
        let mut gpus: Vec<GpuInfo> = Vec::new();

        // Enumerate display adapter subkeys: 0000, 0001, 0002, 0003
        for idx in 0..4 {
            let subkey = format!(
                r"HKLM\SYSTEM\CurrentControlSet\Control\Class\{{4d36e968-e325-11ce-bfc1-08002be10318}}\{:04}",
                idx
            );

            let mut cmd = Command::new("reg");
            cmd.args(["query", &subkey]);
            cmd.creation_flags(CREATE_NO_WINDOW);

            if let Ok(output) = cmd.output() {
                if output.status.success() {
                    let text = String::from_utf8_lossy(&output.stdout);
                    if let Some(gpu) = Self::parse_reg_output(&text) {
                        gpus.push(gpu);
                    }
                }
            }
        }

        let os_version = Self::detect_os_version();
        let wgc_supported = true; // Win 10 1903+
        let zero_copy_supported = true;

        if gpus.is_empty() {
            let fallback = Self::fallback_gpu();
            return GpuCapabilitiesResponse {
                ok: true,
                primary_gpu: fallback.clone(),
                all_gpus: vec![fallback],
                os_version,
                wgc_supported,
                zero_copy_supported,
            };
        }

        // Primary GPU: prefer dedicated GPU over integrated GPU (for gaming / CS2)
        let primary_gpu = gpus
            .iter()
            .find(|g| !g.is_integrated && g.dedicated_vram_mb >= 3000)
            .or_else(|| gpus.iter().find(|g| !g.is_integrated))
            .unwrap_or(&gpus[0])
            .clone();

        GpuCapabilitiesResponse {
            ok: true,
            primary_gpu,
            all_gpus: gpus,
            os_version,
            wgc_supported,
            zero_copy_supported,
        }
    }

    #[cfg(target_os = "windows")]
    fn parse_reg_output(text: &str) -> Option<GpuInfo> {
        let mut driver_desc: Option<String> = None;
        let mut matching_device_id: Option<String> = None;
        let mut driver_version: Option<String> = None;
        let mut vram_bytes: u64 = 0;

        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            if trimmed.starts_with("DriverDesc") {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 3 {
                    driver_desc = Some(parts[2..].join(" "));
                }
            } else if trimmed.starts_with("MatchingDeviceId") {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 3 {
                    matching_device_id = Some(parts[2..].join(" "));
                }
            } else if trimmed.starts_with("DriverVersion") {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 3 {
                    driver_version = Some(parts[2..].join(" "));
                }
            } else if trimmed.starts_with("HardwareInformation.qwMemorySize") {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 3 {
                    let hex_str = parts[2].trim_start_matches("0x");
                    if let Ok(val) = u64::from_str_radix(hex_str, 16) {
                        vram_bytes = val;
                    }
                }
            } else if trimmed.starts_with("HardwareInformation.MemorySize") && vram_bytes == 0 {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 3 {
                    let hex_str = parts[2].trim_start_matches("0x");
                    if let Ok(val) = u64::from_str_radix(hex_str, 16) {
                        vram_bytes = val;
                    }
                }
            }
        }

        let name = driver_desc?;
        let dev_id_lower = matching_device_id.unwrap_or_default().to_lowercase();
        let name_lower = name.to_lowercase();
        let dedicated_vram_mb = vram_bytes / (1024 * 1024);

        // Detect Vendor
        let (vendor, vendor_id) = if dev_id_lower.contains("ven_10de") || name_lower.contains("nvidia") || name_lower.contains("geforce") {
            ("nvidia".to_string(), "10DE".to_string())
        } else if dev_id_lower.contains("ven_1002") || name_lower.contains("amd") || name_lower.contains("radeon") {
            ("amd".to_string(), "1002".to_string())
        } else if dev_id_lower.contains("ven_8086") || name_lower.contains("intel") {
            ("intel".to_string(), "8086".to_string())
        } else {
            ("unknown".to_string(), "".to_string())
        };

        // Detect if integrated
        let is_integrated = if vendor == "amd" {
            name_lower.contains("graphics") && !name_lower.contains("rx ")
                || name_lower.contains("vega")
                || name_lower.contains("apu")
                || name_lower.contains("radeon(tm)")
                || dedicated_vram_mb <= 2048
        } else if vendor == "intel" {
            !name_lower.contains("arc") || dedicated_vram_mb <= 2048
        } else {
            false
        };

        // Classify Architecture, Tier, Encoder and Recommendations
        let (architecture, encoder_tier, max_res, max_fps, preset, codec, av1_supported, notes) =
            Self::classify_hardware(&vendor, &name_lower, is_integrated, dedicated_vram_mb);

        Some(GpuInfo {
            name,
            vendor,
            vendor_id,
            driver_version: driver_version.unwrap_or_else(|| "Desconhecido".to_string()),
            dedicated_vram_mb,
            is_integrated,
            architecture,
            encoder_tier,
            max_recommended_resolution: max_res,
            max_recommended_fps: max_fps,
            recommended_preset: preset,
            recommended_codec: codec,
            av1_encode_supported: av1_supported,
            notes,
        })
    }

    fn classify_hardware(
        vendor: &str,
        name_lower: &str,
        is_integrated: bool,
        vram_mb: u64,
    ) -> (String, String, String, u32, String, String, bool, Vec<String>) {
        let mut notes = Vec::new();

        if vendor == "nvidia" {
            if name_lower.contains("4090")
                || name_lower.contains("4080")
                || name_lower.contains("4070")
                || name_lower.contains("4060")
                || name_lower.contains("4050")
            {
                notes.push("NVENC Ada Lovelace (8ª geração) ativo.".to_string());
                notes.push("Suporte completo a H.264 e AV1 por hardware.".to_string());
                notes.push("Zero impacto de CPU no CS2; WGC zero-copy ativado.".to_string());
                return (
                    "Ada Lovelace".to_string(),
                    "nvenc".to_string(),
                    "1080p".to_string(),
                    60,
                    "high".to_string(),
                    "h264".to_string(),
                    true,
                    notes,
                );
            }

            if name_lower.contains("3090")
                || name_lower.contains("3080")
                || name_lower.contains("3070")
                || name_lower.contains("3060")
                || name_lower.contains("3050")
            {
                notes.push("NVENC Ampere (7ª geração) ativo.".to_string());
                notes.push("Codificação H.264 por hardware com alta folga térmica.".to_string());
                let preset = if name_lower.contains("3050") { "balanced" } else { "high" };
                return (
                    "Ampere".to_string(),
                    "nvenc".to_string(),
                    "1080p".to_string(),
                    60,
                    preset.to_string(),
                    "h264".to_string(),
                    false,
                    notes,
                );
            }

            if name_lower.contains("1650") {
                notes.push("GTX 1650 detectada (Turing TU117 / TU116).".to_string());
                notes.push("Perfil Equilibrado (1080p30/60) mantém o frametime do CS2 estável.".to_string());
                return (
                    "Turing / Volta".to_string(),
                    "nvenc".to_string(),
                    "1080p".to_string(),
                    30,
                    "balanced".to_string(),
                    "h264".to_string(),
                    false,
                    notes,
                );
            }

            if name_lower.contains("1070") || name_lower.contains("1080") || name_lower.contains("1660") || name_lower.contains("2060") {
                notes.push("NVENC Pascal/Turing dedicado com VRAM dedicada.".to_string());
                notes.push("Perfil Equilibrado garante alta fluidez no jogo.".to_string());
                return (
                    "Pascal / Turing".to_string(),
                    "nvenc".to_string(),
                    "1080p".to_string(),
                    60,
                    "balanced".to_string(),
                    "h264".to_string(),
                    false,
                    notes,
                );
            }

            if name_lower.contains("1050") || name_lower.contains("1030") || vram_mb <= 4096 {
                notes.push("GPU de entrada com 4GB VRAM.".to_string());
                notes.push("Perfil Econômico (720p30 / 1080p30) previne disputa por VRAM com o CS2.".to_string());
                return (
                    "Pascal GP107".to_string(),
                    "nvenc".to_string(),
                    "720p".to_string(),
                    30,
                    "eco".to_string(),
                    "h264".to_string(),
                    false,
                    notes,
                );
            }

            return (
                "NVIDIA GeForce".to_string(),
                "nvenc".to_string(),
                "1080p".to_string(),
                60,
                "balanced".to_string(),
                "h264".to_string(),
                false,
                notes,
            );
        }

        if vendor == "amd" {
            if is_integrated {
                notes.push("Gráficos Integrados AMD com Memória Compartilhada (UMA).".to_string());
                notes.push("Modo Econômico (720p30) preserva a banda de RAM do sistema para o CS2.".to_string());
                return (
                    "AMD APU (Memória Compartilhada)".to_string(),
                    "amf_vcn".to_string(),
                    "720p".to_string(),
                    30,
                    "eco".to_string(),
                    "h264".to_string(),
                    false,
                    notes,
                );
            }

            if name_lower.contains("6650")
                || name_lower.contains("6700")
                || name_lower.contains("6750")
                || name_lower.contains("6800")
                || name_lower.contains("6900")
                || name_lower.contains("7600")
                || name_lower.contains("7700")
                || name_lower.contains("7800")
                || name_lower.contains("7900")
            {
                let is_rdna3 = name_lower.contains("7");
                notes.push("AMD RDNA 2/3 com VCN dedicado e Infinity Cache.".to_string());
                notes.push("Aceleração AMF por hardware ativa.".to_string());
                return (
                    if is_rdna3 { "RDNA 3" } else { "RDNA 2" }.to_string(),
                    "amf_vcn".to_string(),
                    "1080p".to_string(),
                    60,
                    "high".to_string(),
                    "h264".to_string(),
                    is_rdna3,
                    notes,
                );
            }

            if name_lower.contains("6600") || name_lower.contains("5600") || name_lower.contains("5700") {
                notes.push("AMD RDNA com 8GB VRAM dedicada.".to_string());
                notes.push("Codificação H.264 acelerada por hardware via AMF/VCN.".to_string());
                return (
                    "RDNA 2 (Navi 23)".to_string(),
                    "amf_vcn".to_string(),
                    "1080p".to_string(),
                    60,
                    "balanced".to_string(),
                    "h264".to_string(),
                    false,
                    notes,
                );
            }

            if name_lower.contains("580") || name_lower.contains("570") || name_lower.contains("590") || name_lower.contains("480") {
                notes.push("Arquitetura Polaris (RX 580) com driver legado Adrenalin.".to_string());
                notes.push("Perfil Econômico (720p30 / 1080p30) recomendado para estabilidade do driver.".to_string());
                return (
                    "Polaris 20".to_string(),
                    "amf_vce".to_string(),
                    "720p".to_string(),
                    30,
                    "eco".to_string(),
                    "h264".to_string(),
                    false,
                    notes,
                );
            }

            return (
                "AMD Radeon".to_string(),
                "amf_vcn".to_string(),
                "1080p".to_string(),
                30,
                "balanced".to_string(),
                "h264".to_string(),
                false,
                notes,
            );
        }

        if vendor == "intel" {
            if name_lower.contains("arc") {
                notes.push("Intel Arc com QuickSync AV1 e H.264 por hardware.".to_string());
                return (
                    "Intel Alchemist".to_string(),
                    "quicksync".to_string(),
                    "1080p".to_string(),
                    60,
                    "high".to_string(),
                    "h264".to_string(),
                    true,
                    notes,
                );
            }

            notes.push("Intel Integrada. Perfil Econômico para poupar CPU.".to_string());
            return (
                "Intel Graphics".to_string(),
                "quicksync".to_string(),
                "720p".to_string(),
                30,
                "eco".to_string(),
                "h264".to_string(),
                false,
                notes,
            );
        }

        notes.push("Encoder padrão do sistema.".to_string());
        (
            "Genérico".to_string(),
            "software".to_string(),
            "720p".to_string(),
            30,
            "eco".to_string(),
            "h264".to_string(),
            false,
            notes,
        )
    }

    #[cfg(target_os = "windows")]
    fn detect_os_version() -> String {
        let mut cmd = Command::new("reg");
        cmd.args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
            "/v",
            "DisplayVersion",
        ]);
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut ver = String::new();
        if let Ok(output) = cmd.output() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                if line.trim().starts_with("DisplayVersion") {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 3 {
                        ver = parts[2].to_string();
                    }
                }
            }
        }

        if ver.is_empty() {
            "Windows 10/11".to_string()
        } else {
            format!("Windows ({})", ver)
        }
    }

    fn fallback_gpu() -> GpuInfo {
        GpuInfo {
            name: "Adaptador de Vídeo Padrão".to_string(),
            vendor: "generic".to_string(),
            vendor_id: "".to_string(),
            driver_version: "N/A".to_string(),
            dedicated_vram_mb: 4096,
            is_integrated: false,
            architecture: "Desconhecida".to_string(),
            encoder_tier: "software".to_string(),
            max_recommended_resolution: "720p".to_string(),
            max_recommended_fps: 30,
            recommended_preset: "eco".to_string(),
            recommended_codec: "h264".to_string(),
            av1_encode_supported: false,
            notes: vec!["Modo de segurança ativado.".to_string()],
        }
    }

    #[allow(dead_code)]
    fn fallback_response() -> GpuCapabilitiesResponse {
        let fallback = Self::fallback_gpu();
        GpuCapabilitiesResponse {
            ok: true,
            primary_gpu: fallback.clone(),
            all_gpus: vec![fallback],
            os_version: "Non-Windows".to_string(),
            wgc_supported: false,
            zero_copy_supported: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_gpu_capabilities() {
        let caps = GpuService::get_capabilities();
        println!("GPU detectada: {}", caps.primary_gpu.name);
        println!("Fabricante: {}", caps.primary_gpu.vendor);
        println!("VRAM: {} MB", caps.primary_gpu.dedicated_vram_mb);
        println!("Arquitetura: {}", caps.primary_gpu.architecture);
        println!("Encoder: {}", caps.primary_gpu.encoder_tier);
        println!("Preset Recomendado: {}", caps.primary_gpu.recommended_preset);
        println!("Codec Recomendado: {}", caps.primary_gpu.recommended_codec);
        println!("AV1 Encode: {}", caps.primary_gpu.av1_encode_supported);
        println!("Notas: {:?}", caps.primary_gpu.notes);
        assert!(caps.ok);
        assert!(!caps.primary_gpu.name.is_empty());
    }
}
