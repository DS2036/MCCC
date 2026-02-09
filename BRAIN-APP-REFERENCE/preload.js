const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('brain', {
    // Configuration
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),
    selectObsidianVault: () => ipcRenderer.invoke('select-obsidian-vault'),

    // File System
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
    writeFile: (filePath, content) => ipcRenderer.invoke('write-file', { filePath, content }),
    listFiles: (dirPath) => ipcRenderer.invoke('list-files', dirPath),
    pathExists: (filePath) => ipcRenderer.invoke('path-exists', filePath),

    // Obsidian Integration
    saveToObsidian: (filename, content, subfolder) => ipcRenderer.invoke('save-to-obsidian', { filename, content, subfolder }),

    // External
    openExternal: (filePath) => ipcRenderer.invoke('open-external', filePath),
    openUrl: (url) => ipcRenderer.invoke('open-url', url),

    // App Control
    restartApp: () => ipcRenderer.invoke('restart-app'),

    // Video Management
    addVideo: (video) => ipcRenderer.invoke('add-video', video),
    updateVideo: (video) => ipcRenderer.invoke('update-video', video),
    deleteVideo: (videoId) => ipcRenderer.invoke('delete-video', videoId),

    // Analysis
    saveAnalysis: (analysis) => ipcRenderer.invoke('save-analysis', analysis),
    getAnalyses: () => ipcRenderer.invoke('get-analyses'),

    // System Stats
    getSystemStats: () => ipcRenderer.invoke('get-system-stats'),

    // Gemini Video Analysis
    setGeminiApiKey: (apiKey) => ipcRenderer.invoke('set-gemini-api-key', apiKey),
    getGeminiSettings: () => ipcRenderer.invoke('get-gemini-settings'),
    setGeminiModel: (model) => ipcRenderer.invoke('set-gemini-model', model),
    getYouTubeTranscript: (url) => ipcRenderer.invoke('get-youtube-transcript', url),
    analyzeVideoGemini: (options) => ipcRenderer.invoke('analyze-video-gemini', options),
    analyzeVideoCombined: (options) => ipcRenderer.invoke('analyze-video-combined', options),
    analyzeYouTubeVideo: (options) => ipcRenderer.invoke('analyze-video-gemini', options),
    analyzeLocalVideo: (options) => ipcRenderer.invoke('analyze-local-video', options),

    // Full Video Analysis (Download + Split + Analyze chunks)
    analyzeYouTubeFull: (options) => ipcRenderer.invoke('analyze-youtube-full', options),
    getVideoInfo: (options) => ipcRenderer.invoke('get-video-info', options),
    cleanupVideo: (options) => ipcRenderer.invoke('cleanup-video', options),

    // Progress events listener
    onAnalysisProgress: (callback) => {
        ipcRenderer.on('analysis-progress', (event, data) => callback(data));
    },
    removeAnalysisProgressListener: () => {
        ipcRenderer.removeAllListeners('analysis-progress');
    },

    // File Selection
    selectFile: (extensions) => ipcRenderer.invoke('select-file', extensions),
    selectFiles: (extensions) => ipcRenderer.invoke('select-files', extensions),

    // Document Analysis
    analyzeDocuments: (options) => ipcRenderer.invoke('analyze-documents', options),

    // Claude Code CLI Export
    exportToClaudeCode: (options) => ipcRenderer.invoke('export-to-claude-code', options),

    // Claude Code CLI Integration
    checkClaudeCLI: () => ipcRenderer.invoke('check-claude-cli'),
    runClaudeAgent: (options) => ipcRenderer.invoke('run-claude-agent', options),
    stopClaudeAgent: (processId) => ipcRenderer.invoke('stop-claude-agent', { processId }),
    runClaudeWithContext: (options) => ipcRenderer.invoke('run-claude-with-context', options),
    openProjectFolder: (projectPath) => ipcRenderer.invoke('open-project-folder', { projectPath }),
    openTerminalInProject: (projectPath) => ipcRenderer.invoke('open-terminal-in-project', { projectPath }),

    // Claude streaming events
    onClaudeStream: (callback) => {
        ipcRenderer.on('claude-stream', (event, data) => callback(data));
    },
    onClaudeComplete: (callback) => {
        ipcRenderer.on('claude-complete', (event, data) => callback(data));
    },
    removeClaudeListeners: () => {
        ipcRenderer.removeAllListeners('claude-stream');
        ipcRenderer.removeAllListeners('claude-complete');
    },

    // Backup System
    createBackup: (options) => ipcRenderer.invoke('create-backup', options),
    listBackups: () => ipcRenderer.invoke('list-backups'),
    restoreBackup: (name) => ipcRenderer.invoke('restore-backup', name),
    deleteBackup: (name) => ipcRenderer.invoke('delete-backup', name),
    exportToObsidian: () => ipcRenderer.invoke('export-to-obsidian-backup'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // Folder Persistence (via electron-store for reliability)
    getFolders: () => ipcRenderer.invoke('get-folders'),
    saveFolders: (folders) => ipcRenderer.invoke('save-folders', folders),
    getCustomContent: () => ipcRenderer.invoke('get-custom-content'),
    saveCustomContent: (content) => ipcRenderer.invoke('save-custom-content', content),

    // Platform info
    platform: process.platform,
    isElectron: true
});

console.log('Brain App preload script loaded');
