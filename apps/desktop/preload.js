const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sfDesktop', {
  getConfig: () => ipcRenderer.invoke('sf:get-config'),
  getSettings: () => ipcRenderer.invoke('sf:get-settings'),
  setSettings: (partial) => ipcRenderer.invoke('sf:set-settings', partial),
  getSavedCreds: () => ipcRenderer.invoke('sf:get-saved-creds'),
  saveCreds: (username, password) => ipcRenderer.invoke('sf:save-creds', { username, password }),
  clearCreds: () => ipcRenderer.invoke('sf:clear-creds'),
  authStatus: () => ipcRenderer.invoke('sf:auth-status'),
  login: (username, password, remember) =>
    ipcRenderer.invoke('sf:login', { username, password, remember: !!remember }),
  registerSendCode: (phone) => ipcRenderer.invoke('sf:register-send-code', { phone }),
  register: (payload) => ipcRenderer.invoke('sf:register', payload),
  logout: () => ipcRenderer.invoke('sf:logout'),
  openRegister: () => ipcRenderer.invoke('sf:open-register'),
  openLogin: () => ipcRenderer.invoke('sf:open-login'),
  getPickerSources: () => ipcRenderer.invoke('sf:get-picker-sources'),
  pickSource: (id) => ipcRenderer.invoke('sf:pick-source', id),
  cancelPickSource: () => ipcRenderer.invoke('sf:cancel-pick-source'),
  focusWindow: () => ipcRenderer.invoke('sf:focus-window'),
  openExternal: (url) => ipcRenderer.invoke('sf:open-external', url),
  startLocalStream: (opts) => ipcRenderer.invoke('sf:start-local-stream', opts || {}),
  stopLocalStream: () => ipcRenderer.invoke('sf:stop-local-stream'),
  setShareAudioMode: (mode) => ipcRenderer.invoke('sf:set-share-audio-mode', mode),
  setShareCapturePrefs: (prefs) => ipcRenderer.invoke('sf:set-share-capture-prefs', prefs || {}),
  setShareActive: (active) => ipcRenderer.invoke('sf:set-share-active', !!active),
  ensureSpeakersUnmuted: () => ipcRenderer.invoke('sf:ensure-speakers-unmuted'),
  getAudioMuted: () => ipcRenderer.invoke('sf:get-audio-muted'),
  setAudioMuted: (muted) => ipcRenderer.invoke('sf:set-audio-muted', !!muted),
  voiceLog: (event, data) => {
    try {
      ipcRenderer.send('sf:voice-log', { event: String(event || ''), data: data || {} });
    } catch {
      /* ignore */
    }
  },
  onRestoreVoiceAudio: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = () => {
      try {
        callback();
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on('sf:restore-voice-audio', handler);
    return () => ipcRenderer.removeListener('sf:restore-voice-audio', handler);
  },
  startGameAudioCapture: () => ipcRenderer.invoke('sf:start-game-audio'),
  startSystemAudioCapture: () => ipcRenderer.invoke('sf:start-system-audio'),
  stopGameAudioCapture: () => ipcRenderer.invoke('sf:stop-game-audio'),
  onGameAudioChunk: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, chunk) => {
      let bytes;
      if (chunk instanceof ArrayBuffer) {
        bytes = new Uint8Array(chunk.slice(0));
      } else if (chunk?.type === 'Buffer' && Array.isArray(chunk.data)) {
        bytes = Uint8Array.from(chunk.data);
      } else if (ArrayBuffer.isView(chunk)) {
        bytes = new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
      } else if (chunk?.buffer) {
        bytes = new Uint8Array(
          chunk.buffer.slice(chunk.byteOffset || 0, (chunk.byteOffset || 0) + (chunk.byteLength || 0)),
        );
      } else {
        return;
      }
      callback(bytes);
    };
    ipcRenderer.on('sf:game-audio-chunk', handler);
    return () => ipcRenderer.removeListener('sf:game-audio-chunk', handler);
  },
  getUpdateStatus: () => ipcRenderer.invoke('sf:get-update-status'),
  promptInstallUpdate: () => ipcRenderer.invoke('sf:prompt-install-update'),
  remoteStatus: () => ipcRenderer.invoke('sf:remote-status'),
  remotePrepareHost: (opts) => ipcRenderer.invoke('sf:remote-prepare-host', opts || {}),
  remoteConnect: (opts) => ipcRenderer.invoke('sf:remote-connect', opts || {}),
  remoteEnd: () => ipcRenderer.invoke('sf:remote-end'),
  matchPrepareHost: (opts) => ipcRenderer.invoke('sf:match-prepare-host', opts || {}),
  matchEnsurePack: (version) =>
    ipcRenderer.invoke('sf:match-ensure-pack', typeof version === 'string' ? { version } : version || {}),
  matchListInstalledPacks: () => ipcRenderer.invoke('sf:match-list-installed-packs'),
  onMatchBootProgress: (callback) => {
    const handler = (_e, payload) => {
      try {
        callback(payload);
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on('sf:match-boot-progress', handler);
    return () => ipcRenderer.removeListener('sf:match-boot-progress', handler);
  },
  matchOpenTunnel: (opts) => ipcRenderer.invoke('sf:match-open-tunnel', opts || {}),
  matchConnect: (opts) => ipcRenderer.invoke('sf:match-connect', opts || {}),
  matchOpenCs2: () => ipcRenderer.invoke('sf:match-open-cs2'),
  matchDedicatedStatus: () => ipcRenderer.invoke('sf:match-dedicated-status'),
  matchDedicatedStop: () => ipcRenderer.invoke('sf:match-dedicated-stop'),
  matchDedicatedSnapshot: () => ipcRenderer.invoke('sf:match-dedicated-snapshot'),
  matchDedicatedExec: (cmd) => ipcRenderer.invoke('sf:match-dedicated-exec', cmd || ''),
  matchRewriteTeams: (players) => ipcRenderer.invoke('sf:match-rewrite-teams', players || []),
  matchAdminSettings: (settings) => ipcRenderer.invoke('sf:match-admin-settings', settings || {}),
  matchSoundSettings: (settings) => ipcRenderer.invoke('sf:match-sound-settings', settings || {}),
  matchSoundPrefsGet: () => ipcRenderer.invoke('sf:match-sound-prefs-get'),
  matchAdminBots: (action) => ipcRenderer.invoke('sf:match-admin-bots', action || ''),
  matchGsltGet: () => ipcRenderer.invoke('sf:match-gslt-get'),
  matchGsltSet: (token) => ipcRenderer.invoke('sf:match-gslt-set', token || ''),
  matchConsoleKeyGet: () => ipcRenderer.invoke('sf:match-console-key-get'),
  matchConsoleKeySet: (vk) => ipcRenderer.invoke('sf:match-console-key-set', vk),
  matchHistoryList: (opts) => ipcRenderer.invoke('sf:match-history-list', opts || {}),
  matchHistoryPush: (entry) => ipcRenderer.invoke('sf:match-history-push', entry || {}),
  matchHistoryClear: () => ipcRenderer.invoke('sf:match-history-clear'),
  gsiStatus: () => ipcRenderer.invoke('sf:gsi-status'),
  gsiEnable: () => ipcRenderer.invoke('sf:gsi-enable'),
  gsiRedeploy: () => ipcRenderer.invoke('sf:gsi-redeploy'),
  gsiDisable: () => ipcRenderer.invoke('sf:gsi-disable'),
  gsiDetect: () => ipcRenderer.invoke('sf:gsi-detect'),
  gsiHistory: (opts) => ipcRenderer.invoke('sf:gsi-history', opts || {}),
  gsiHistoryGet: (id) => ipcRenderer.invoke('sf:gsi-history-get', id),
  gsiHistoryClear: () => ipcRenderer.invoke('sf:gsi-history-clear'),
  gsiHistoryMergeValve: (matchId, valve) =>
    ipcRenderer.invoke('sf:gsi-history-merge-valve', { matchId, valve }),
  onGsiUpdate: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('sf:gsi-update', handler);
    return () => ipcRenderer.removeListener('sf:gsi-update', handler);
  },
  onGsiMatchSaved: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('sf:gsi-match-saved', handler);
    return () => ipcRenderer.removeListener('sf:gsi-match-saved', handler);
  },
  onUpdateStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('sf:update-status', handler);
    return () => ipcRenderer.removeListener('sf:update-status', handler);
  },
  onLeaving: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = () => {
      try {
        callback();
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on('sf:leaving', handler);
    return () => ipcRenderer.removeListener('sf:leaving', handler);
  },
});
