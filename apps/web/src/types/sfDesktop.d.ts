export {};

declare global {
  interface Window {
    sfDesktop?: {
      getConfig: () => Promise<{
        serverUrl: string;
        desktop: boolean;
        version?: string;
        isDev?: boolean;
      }>;
      getSettings?: () => Promise<{ minimizeToTray?: boolean; openAtLogin?: boolean }>;
      setSettings?: (partial: Record<string, unknown>) => Promise<unknown>;
      getSavedCreds?: () => Promise<{ username?: string; password?: string } | null>;
      saveCreds?: (username: string, password: string) => Promise<unknown>;
      clearCreds?: () => Promise<unknown>;
      login?: (
        username: string,
        password: string,
        remember?: boolean,
      ) => Promise<{ status?: number; ok?: boolean; user?: unknown; error?: string }>;
      logout: () => Promise<unknown>;
      openExternal?: (url: string) => Promise<unknown>;
      windowMinimize?: () => Promise<void>;
      windowToggleMaximize?: () => Promise<boolean>;
      windowIsMaximized?: () => Promise<boolean>;
      windowClose?: () => Promise<void>;
      windowStartDragging?: () => Promise<void>;
      getHardwareTelemetry?: () => Promise<{
        timestamp_ms: number;
        cpu_global_pct: number;
        cpu_process_pct: number;
        ram_process_mb: number;
        gpu_3d_pct: number;
        gpu_video_encode_pct: number;
        gpu_copy_engine_pct: number;
        vram_used_mb: number;
        vram_total_mb: number;
      }>;
      startHardwareTelemetry?: () => Promise<{ ok: boolean; sampling: boolean }>;
      stopHardwareTelemetry?: () => Promise<{ ok: boolean; sampling: boolean }>;
      onHardwareTelemetry?: (callback: (telemetry: {
        timestamp_ms: number;
        cpu_global_pct: number;
        cpu_process_pct: number;
        ram_process_mb: number;
        gpu_3d_pct: number;
        gpu_video_encode_pct: number;
        gpu_copy_engine_pct: number;
        vram_used_mb: number;
        vram_total_mb: number;
      }) => void) => () => void;
      getGpuCapabilities?: () => Promise<{
        ok: boolean;
        primaryGpu: {
          name: string;
          vendor: string;
          vendorId: string;
          driverVersion: string;
          dedicatedVramMb: number;
          isIntegrated: boolean;
          architecture: string;
          encoderTier: string;
          maxRecommendedResolution: string;
          maxRecommendedFps: number;
          recommendedPreset: string;
          recommendedCodec: string;
          av1EncodeSupported: boolean;
          notes: string[];
        };
        allGpus: Array<{
          name: string;
          vendor: string;
          vendorId: string;
          driverVersion: string;
          dedicatedVramMb: number;
          isIntegrated: boolean;
          architecture: string;
          encoderTier: string;
          maxRecommendedResolution: string;
          maxRecommendedFps: number;
          recommendedPreset: string;
          recommendedCodec: string;
          av1EncodeSupported: boolean;
          notes: string[];
        }>;
        osVersion: string;
        wgcSupported: boolean;
        zeroCopySupported: boolean;
      }>;
      setShareAudioMode: (mode: string) => Promise<unknown>;
      setShareCapturePrefs: (prefs: Record<string, unknown>) => Promise<unknown>;
      setShareActive?: (active: boolean) => Promise<{ ok?: boolean; shareActive?: boolean }>;
      ensureSpeakersUnmuted?: () => Promise<{ ok?: boolean }>;
      getAudioMuted?: () => Promise<{ ok?: boolean; muted?: boolean | null }>;
      setAudioMuted?: (muted: boolean) => Promise<{ ok?: boolean; muted?: boolean }>;
      /** Debug: envia log para o terminal do Electron main */
      voiceLog?: (event: string, data?: Record<string, unknown>) => void;
      onRestoreVoiceAudio?: (callback: () => void) => () => void;
      startGameAudioCapture: () => Promise<unknown>;
      startSystemAudioCapture?: () => Promise<unknown>;
      stopGameAudioCapture: () => Promise<unknown>;
      getAudioRoutingStatus?: () => Promise<{
        is_capturing: boolean;
        mode: string;
        target_process_name: string;
        target_pid: number | null;
        os_build: number;
        supports_process_loopback: boolean;
        chunks_emitted: number;
        last_chunk_ts_ms: number;
      }>;
      onGameAudioChunk: (callback: (chunk: Uint8Array) => void) => () => void;
      getUpdateStatus: () => Promise<{
        available?: boolean;
        ready?: boolean;
        downloading?: boolean;
        version?: string;
      }>;
      promptInstallUpdate: () => Promise<unknown>;
      remoteStatus?: () => Promise<{
        ok?: boolean;
        rustdeskId?: string;
        error?: string;
        exe?: string;
      }>;
      remotePrepareHost?: (opts: {
        password: string;
      }) => Promise<{ ok?: boolean; rustdesk_id?: string; error?: string }>;
      remoteConnect?: (opts: {
        host_id: string;
        password?: string;
      }) => Promise<{ ok?: boolean; error?: string }>;
      remoteEnd?: () => Promise<{ ok?: boolean; error?: string }>;
      matchPrepareHost?: (opts: {
        password?: string;
        map?: string;
        port?: number;
        gslt?: string;
        hostname?: string;
        cheats?: boolean;
        matchPackVersion?: string;
        adminSettings?: Record<string, number | undefined>;
        soundSettings?: Record<string, unknown>;
        welcomeMessage?: string;
        welcomeColor?: string;
        players?: Array<{
          userId?: number;
          username?: string;
          displayName?: string;
          name?: string;
          steamid?: string;
          team?: string;
          simulated?: boolean;
        }>;
      }) => Promise<{
        ok?: boolean;
        stub?: boolean;
        dedicated?: boolean;
        phase?: string;
        host?: string;
        lanHost?: string;
        publicHost?: string;
        port?: number;
        password?: string;
        map?: string;
        hostname?: string;
        cheats?: boolean;
        connectString?: string;
        message?: string;
        error?: string;
        pid?: number;
        cs2Path?: string;
        logTail?: string;
        needsGslt?: boolean;
        gsltUrl?: string;
        readyConfirmed?: boolean;
        readyVia?: string;
        upnpOk?: boolean;
      }>;
      onMatchBootProgress?: (
        callback: (payload: { phase?: string; message?: string; pid?: number; port?: number }) => void,
      ) => () => void;
      matchEnsurePack?: (
        versionOrOpts: string | { version?: string },
      ) => Promise<{
        ok?: boolean;
        version?: string;
        pluginVersion?: string;
        defaults?: Record<string, number>;
        changelog?: string;
        error?: string;
        bytes?: number;
        cached?: boolean;
      }>;
      matchListInstalledPacks?: () => Promise<{
        ok?: boolean;
        versions?: string[];
        active?: string | null;
        error?: string;
      }>;
      matchOpenTunnel?: (opts: {
        matchId: string;
        localPort: number;
      }) => Promise<{
        ok?: boolean;
        via?: string;
        publicHost?: string;
        publicPort?: number;
        relayHost?: string;
        relayPort?: number;
        error?: string;
      }>;
      matchConnect?: (opts: {
        host: string;
        port?: number;
        password?: string;
        map?: string;
        consoleVk?: number;
        forceRelaunch?: boolean;
        allowRelaunch?: boolean;
        players?: Array<{
          userId?: number;
          username?: string;
          displayName?: string;
          name?: string;
          steamid?: string;
          team?: string;
          simulated?: boolean;
        }>;
      }) => Promise<{
        ok?: boolean;
        connectString?: string;
        copied?: boolean;
        steamLaunch?: boolean;
        injected?: boolean;
        relaunched?: boolean;
        gameWasOpen?: boolean;
        via?: string;
        note?: string;
        error?: string;
        message?: string;
      }>;
      matchOpenCs2?: () => Promise<{ ok?: boolean; error?: string }>;
      matchDedicatedStatus?: () => Promise<{
        ok?: boolean;
        running?: boolean;
        pid?: number | null;
        host?: string | null;
        port?: number | null;
        map?: string | null;
        hostname?: string | null;
        cheats?: boolean;
        readyConfirmed?: boolean;
        message?: string;
        error?: string;
      }>;
      matchDedicatedStop?: () => Promise<{ ok?: boolean; stopped?: boolean; error?: string }>;
      matchDedicatedSnapshot?: () => Promise<{
        ok?: boolean;
        running?: boolean;
        pid?: number | null;
        host?: string | null;
        port?: number | null;
        map?: string | null;
        password?: string | null;
        hostname?: string | null;
        cheats?: boolean;
        startedAt?: number | null;
        logPath?: string | null;
        logTail?: string;
        playersInServer?: Array<{ name: string }>;
        error?: string;
      }>;
      matchDedicatedExec?: (cmd: string) => Promise<{
        ok?: boolean;
        cmd?: string;
        cmds?: string[];
        error?: string;
        hint?: string;
        via?: string;
      }>;
      matchRewriteTeams?: (
        players: Array<{
          userId?: number;
          username?: string;
          displayName?: string;
          name?: string;
          steamid?: string;
          team?: string;
          simulated?: boolean;
        }>,
      ) => Promise<{ ok?: boolean; file?: string; count?: number; error?: string }>;
      matchAdminSettings?: (settings: Record<string, number | boolean | string | undefined>) => Promise<{
        ok?: boolean;
        settings?: Record<string, unknown>;
        error?: string;
        hint?: string;
        via?: string;
      }>;
      matchSoundSettings?: (settings: Record<string, unknown>) => Promise<{
        ok?: boolean;
        settings?: Record<string, unknown>;
        file?: string;
        error?: string;
      }>;
      matchSoundPrefsGet?: () => Promise<{
        ok?: boolean;
        settings?: Record<string, unknown>;
        error?: string;
      }>;
      matchAdminBots?: (action: string) => Promise<{
        ok?: boolean;
        cmd?: string;
        error?: string;
        hint?: string;
        via?: string;
      }>;
      matchGsltGet?: () => Promise<{
        ok?: boolean;
        hasToken?: boolean;
        tokenPreview?: string;
        url?: string;
        error?: string;
      }>;
      matchGsltSet?: (token: string) => Promise<{ ok?: boolean; hasToken?: boolean; error?: string }>;
      matchConsoleKeyGet?: () => Promise<{
        ok?: boolean;
        configured?: boolean;
        consoleVk?: number;
        options?: Array<{ vk: number; label: string }>;
        error?: string;
      }>;
      matchConsoleKeySet?: (vk: number) => Promise<{
        ok?: boolean;
        consoleVk?: number;
        configured?: boolean;
        error?: string;
      }>;
      matchHistoryList?: (opts?: { limit?: number }) => Promise<{
        ok?: boolean;
        matches?: Array<Record<string, unknown>>;
        error?: string;
      }>;
      matchHistoryPush?: (entry: Record<string, unknown>) => Promise<{
        ok?: boolean;
        match?: Record<string, unknown>;
        error?: string;
      }>;
      matchHistoryClear?: () => Promise<{ ok?: boolean; error?: string }>;
      gsiStatus?: () => Promise<{
        ok?: boolean;
        enabled?: boolean;
        listening?: boolean;
        receiving?: boolean;
        waiting?: boolean;
        port?: number;
        cfgDir?: string;
        cfgPath?: string;
        error?: string;
        snapshot?: unknown;
        enabledSetting?: boolean;
      }>;
      gsiEnable?: () => Promise<{ ok?: boolean; error?: string; cfgDir?: string }>;
      gsiRedeploy?: () => Promise<{ ok?: boolean; error?: string; cfgDir?: string }>;
      gsiDisable?: () => Promise<{ ok?: boolean; error?: string }>;
      gsiDetect?: () => Promise<{ ok?: boolean; cfgDir?: string }>;
      gsiHistory?: (opts?: { limit?: number }) => Promise<{
        ok?: boolean;
        matches?: Array<Record<string, unknown>>;
      }>;
      gsiHistoryGet?: (id: string) => Promise<{ ok?: boolean; match?: Record<string, unknown> | null }>;
      gsiHistoryClear?: () => Promise<{ ok?: boolean }>;
      gsiHistoryMergeValve?: (
        matchId: string,
        valve: Record<string, unknown>,
      ) => Promise<{ ok?: boolean; match?: Record<string, unknown>; error?: string }>;
      onGsiUpdate?: (cb: (snapshot: unknown) => void) => () => void;
      onGsiMatchSaved?: (cb: (match: unknown) => void) => () => void;
      onUpdateStatus: (
        cb: (status: {
          available?: boolean;
          ready?: boolean;
          downloading?: boolean;
          version?: string;
        }) => void,
      ) => () => void;
      /** App fechando / indo para bandeja — sair da voz */
      onLeaving?: (cb: () => void) => () => void;
      focusWindow: () => Promise<unknown>;
      // Crash Diagnostics & Device Recovery (RFC v3.0 - Etapa 2)
      getCrashDiagnostics?: () => Promise<{
        generated_at_ms: number;
        environment: {
          os_name: string;
          os_version: string;
          architecture: string;
          working_set_mb: number;
          handle_count: number;
          thread_count: number;
        };
        total_events: number;
        events: Array<{
          id: number;
          timestamp_ms: number;
          subsystem: string;
          level: string;
          event_name: string;
          details_json: string;
        }>;
      }>;
      recordDiagnosticEvent?: (
        subsystem: string,
        level: string,
        eventName: string,
        detailsJson?: string,
      ) => Promise<void>;
      clearCrashDiagnostics?: () => Promise<void>;
      getSubsystemHealth?: () => Promise<
        Array<{
          id: string;
          health: unknown;
          recovery_count: number;
          last_recovered_ms?: number | null;
        }>
      >;
      triggerSubsystemRecovery?: (subsystem: string, reason: string) => Promise<void>;
      onSubsystemRecovery?: (
        cb: (data: { subsystem: string; state: string; timestamp_ms: number }) => void,
      ) => () => void;

      // PerformanceGuardian & Watchdog (RFC v3.0 - Etapa 3)
      getGuardianStatus?: () => Promise<{
        pressure_level: 'Normal' | 'Moderate' | 'High' | 'Critical';
        cpu_global_pct: number;
        cpu_app_pct: number;
        cs2_running: boolean;
        cs2_pid: number | null;
        timestamp_ms: number;
      }>;
      startGuardian?: () => Promise<void>;
      stopGuardian?: () => Promise<void>;
      onGuardianAlert?: (
        cb: (status: {
          pressure_level: 'Normal' | 'Moderate' | 'High' | 'Critical';
          cpu_global_pct: number;
          cpu_app_pct: number;
          cs2_running: boolean;
          cs2_pid: number | null;
          timestamp_ms: number;
        }) => void,
      ) => () => void;
      getPickerSources?: () => Promise<
        Array<{ id: string; name: string; thumbnailDataUrl?: string }>
      >;
      pickSource?: (id: string) => Promise<unknown>;
      cancelPickSource?: () => Promise<unknown>;
    };
  }
}
