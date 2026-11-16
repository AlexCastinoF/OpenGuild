/**
 * OpenGuild Tauri Bridge
 * Replaces Electron's preload.js / ipcRenderer bridge.
 * Exposes window.sfDesktop identically to apps/web/src/types/sfDesktop.d.ts.
 */
(function () {
  if (typeof window === 'undefined') return;

  // Disable default browser context menu ("Voltar", "Atualizar", "Imprimir", etc.)
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  }, false);

  async function invoke(cmd, args) {
    try {
      if (window.__TAURI__?.core?.invoke) {
        return await window.__TAURI__.core.invoke(cmd, args || {});
      }
      if (window.__TAURI_INTERNALS__?.invoke) {
        return await window.__TAURI_INTERNALS__.invoke(cmd, args || {});
      }
      console.warn('[sfDesktop] Tauri invoke not ready for command:', cmd);
      return null;
    } catch (err) {
      console.error(`[sfDesktop] Error executing command "${cmd}":`, err);
      throw err;
    }
  }

  function listen(eventName, callback) {
    if (typeof callback !== 'function') return () => {};
    let unlistenFn = null;
    let cancelled = false;

    const setupListener = async () => {
      if (window.__TAURI__?.event?.listen) {
        const unlisten = await window.__TAURI__.event.listen(eventName, (event) => {
          if (!cancelled) callback(event.payload);
        });
        if (cancelled) unlisten();
        else unlistenFn = unlisten;
      }
    };

    void setupListener();

    return () => {
      cancelled = true;
      if (typeof unlistenFn === 'function') {
        try {
          unlistenFn();
        } catch (_) {}
      }
    };
  }

  window.sfDesktop = {
    // System & Config
    getConfig: () => invoke('get_config'),
    getSettings: () => invoke('get_settings'),
    setSettings: (partial) => invoke('set_settings', { partial: partial || {} }),
    getSavedCreds: () => invoke('get_saved_creds'),
    saveCreds: (username, password) => invoke('save_creds', { username, password }),
    clearCreds: () => invoke('clear_creds'),
    authStatus: () => invoke('auth_status'),
    login: (username, password, remember) =>
      invoke('login', { username, password, remember: !!remember }),
    registerSendCode: (phone) => invoke('register_send_code', { phone }),
    register: (payload) => invoke('register', { payload }),
    logout: () => invoke('logout'),
    openRegister: () => invoke('open_register'),
    openLogin: () => invoke('open_login'),
    focusWindow: () => invoke('focus_window'),
    windowMinimize: () => invoke('window_minimize'),
    windowToggleMaximize: () => invoke('window_toggle_maximize'),
    windowIsMaximized: () => invoke('window_is_maximized'),
    windowClose: () => invoke('window_close'),
    windowStartDragging: () => invoke('window_start_dragging'),
    openExternal: (url) => invoke('open_external', { url }),
    getGpuCapabilities: () => invoke('get_gpu_capabilities'),

    // Hardware Telemetry (RFC v3.0)
    getHardwareTelemetry: () => invoke('get_hardware_telemetry'),
    startHardwareTelemetry: () => invoke('start_hardware_telemetry'),
    stopHardwareTelemetry: () => invoke('stop_hardware_telemetry'),
    onHardwareTelemetry: (callback) => listen('sf:hardware-telemetry', callback),

    // Screen Share & Audio
    getPickerSources: () => invoke('get_picker_sources'),
    pickSource: (id) => invoke('pick_source', { id }),
    cancelPickSource: () => invoke('cancel_pick_source'),
    startLocalStream: (opts) => invoke('start_local_stream', { opts: opts || {} }),
    stopLocalStream: () => invoke('stop_local_stream'),
    setShareAudioMode: (mode) => invoke('set_share_audio_mode', { mode }),
    setShareCapturePrefs: (prefs) => invoke('set_share_capture_prefs', { prefs: prefs || {} }),
    setShareActive: (active) => invoke('set_share_active', { active: !!active }),
    ensureSpeakersUnmuted: () => invoke('ensure_speakers_unmuted'),
    getAudioMuted: () => invoke('get_audio_muted'),
    setAudioMuted: (muted) => invoke('set_audio_muted', { muted: !!muted }),
    voiceLog: (event, data) => {
      try {
        void invoke('voice_log', { event: String(event || ''), data: data || {} });
      } catch (_) {}
    },
    onRestoreVoiceAudio: (callback) => listen('sf:restore-voice-audio', callback),
    startGameAudioCapture: () => invoke('start_game_audio'),
    startSystemAudioCapture: () => invoke('start_system_audio'),
    stopGameAudioCapture: () => invoke('stop_game_audio'),
    getAudioRoutingStatus: () => invoke('get_audio_routing_status'),
    onGameAudioChunk: (callback) => {
      return listen('sf:game-audio-chunk', (chunk) => {
        let bytes;
        if (chunk instanceof Uint8Array) {
          bytes = chunk;
        } else if (Array.isArray(chunk)) {
          bytes = new Uint8Array(chunk);
        } else if (typeof chunk === 'string') {
          // Base64 decoded
          const bin = atob(chunk);
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else if (chunk?.data && Array.isArray(chunk.data)) {
          bytes = new Uint8Array(chunk.data);
        }
        if (bytes) callback(bytes);
      });
    },

    // Updates
    getUpdateStatus: () => invoke('get_update_status'),
    promptInstallUpdate: () => invoke('prompt_install_update'),
    onUpdateStatus: (callback) => listen('sf:update-status', callback),

    // Remote Access (RustDesk)
    remoteStatus: () => invoke('remote_status'),
    remotePrepareHost: (opts) => invoke('remote_prepare_host', { opts: opts || {} }),
    remoteConnect: (opts) => invoke('remote_connect', { opts: opts || {} }),
    remoteEnd: () => invoke('remote_end'),

    // CS2 Matches & Dedicated
    matchPrepareHost: (opts) => invoke('match_prepare_host', { opts: opts || {} }),
    matchEnsurePack: (version) =>
      invoke('match_ensure_pack', typeof version === 'string' ? { version } : version || {}),
    matchListInstalledPacks: () => invoke('match_list_installed_packs'),
    onMatchBootProgress: (callback) => listen('sf:match-boot-progress', callback),
    matchOpenTunnel: (opts) => invoke('match_open_tunnel', { opts: opts || {} }),
    matchConnect: (opts) => invoke('match_connect', { opts: opts || {} }),
    matchOpenCs2: () => invoke('match_open_cs2'),
    matchDedicatedStatus: () => invoke('match_dedicated_status'),
    matchDedicatedStop: () => invoke('match_dedicated_stop'),
    matchDedicatedSnapshot: () => invoke('match_dedicated_snapshot'),
    matchDedicatedExec: (cmd) => invoke('match_dedicated_exec', { cmd: cmd || '' }),
    matchRewriteTeams: (players) => invoke('match_rewrite_teams', { players: players || [] }),
    matchAdminSettings: (settings) => invoke('match_admin_settings', { settings: settings || {} }),
    matchSoundSettings: (settings) => invoke('match_sound_settings', { settings: settings || {} }),
    matchSoundPrefsGet: () => invoke('match_sound_prefs_get'),
    matchAdminBots: (action) => invoke('match_admin_bots', { action: action || '' }),
    matchGsltGet: () => invoke('match_gslt_get'),
    matchGsltSet: (token) => invoke('match_gslt_set', { token: token || '' }),
    matchConsoleKeyGet: () => invoke('match_console_key_get'),
    matchConsoleKeySet: (vk) => invoke('match_console_key_set', { vk }),
    matchHistoryList: (opts) => invoke('match_history_list', { opts: opts || {} }),
    matchHistoryPush: (entry) => invoke('match_history_push', { entry: entry || {} }),
    matchHistoryClear: () => invoke('match_history_clear'),

    // CS2 Game State Integration (GSI)
    gsiStatus: () => invoke('gsi_status'),
    gsiEnable: () => invoke('gsi_enable'),
    gsiRedeploy: () => invoke('gsi_redeploy'),
    gsiDisable: () => invoke('gsi_disable'),
    gsiDetect: () => invoke('gsi_detect'),
    gsiHistory: (opts) => invoke('gsi_history', { opts: opts || {} }),
    gsiHistoryGet: (id) => invoke('gsi_history_get', { id }),
    gsiHistoryClear: () => invoke('gsi_history_clear'),
    gsiHistoryMergeValve: (matchId, valve) =>
      invoke('gsi_history_merge_valve', { matchId, valve }),
    onGsiUpdate: (callback) => listen('sf:gsi-update', callback),
    onGsiMatchSaved: (callback) => listen('sf:gsi-match-saved', callback),

    // Crash Diagnostics & Device Recovery (RFC v3.0 - Etapa 2)
    getCrashDiagnostics: () => invoke('get_crash_diagnostics'),
    recordDiagnosticEvent: (subsystem, level, eventName, detailsJson) =>
      invoke('record_diagnostic_event', { subsystem, level, eventName, detailsJson }),
    clearCrashDiagnostics: () => invoke('clear_crash_diagnostics'),
    getSubsystemHealth: () => invoke('get_subsystem_health'),
    triggerSubsystemRecovery: (subsystem, reason) =>
      invoke('trigger_subsystem_recovery', { subsystem, reason }),
    onSubsystemRecovery: (callback) => listen('sf:subsystem-recovery', callback),

    // PerformanceGuardian & Watchdog (RFC v3.0 - Etapa 3)
    getGuardianStatus: () => invoke('get_guardian_status'),
    startGuardian: () => invoke('start_guardian'),
    stopGuardian: () => invoke('stop_guardian'),
    onGuardianAlert: (callback) => listen('sf:performance-guardian-alert', callback),

    // App leaving
    onLeaving: (callback) => listen('sf:leaving', callback),
  };

  console.log('[sfDesktop] Tauri bridge initialized successfully.');
})();
