const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// electron-store v10+ is ESM, need dynamic import
let store = null;
async function initStore() {
    const Store = (await import('electron-store')).default;
    store = new Store({
        name: 'brain-config',
        defaults: {
            obsidianVaultPath: '',
            videos: [],
            analyses: [],
            windowBounds: { width: 1400, height: 900 },
            geminiApiKey: '',
            geminiModel: 'gemini-2.5-flash'
        }
    });
    return store;
}
const { YoutubeTranscript } = require('youtube-transcript');
const https = require('https');
const http = require('http');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const readline = require('readline');

// Handle EPIPE errors globally - occurs when writing to closed pipes during shutdown
process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') {
        // Silently ignore - this is expected during app shutdown
        return;
    }
    console.error('stdout error:', err);
});

process.stderr.on('error', (err) => {
    if (err.code === 'EPIPE') {
        return;
    }
});

// Handle uncaught exceptions to prevent crashes
process.on('uncaughtException', (err) => {
    if (err.code === 'EPIPE') {
        // Ignore EPIPE errors - they happen during shutdown
        return;
    }
    console.error('Uncaught Exception:', err);
});

// Video processing directory
const TEMP_VIDEO_DIR = path.join(app.getPath('userData'), 'temp_videos');
const CHUNKS_DIR = path.join(TEMP_VIDEO_DIR, 'chunks');

// Track running Claude processes for restart warning
const runningClaudeProcesses = new Map(); // processId -> { name, startTime }

// Track running video analyses to prevent duplicates
const runningVideoAnalyses = new Map(); // videoId -> { startTime, promise }

// Initialize Gemini AI (will be set when API key is available)
let genAI = null;

function initializeGemini(apiKey) {
    if (apiKey) {
        genAI = new GoogleGenerativeAI(apiKey);
        return true;
    }
    return false;
}

// Initialize store and Gemini after app is ready
async function initializeApp() {
    await initStore();
    const storedApiKey = store.get('geminiApiKey');
    if (storedApiKey) {
        initializeGemini(storedApiKey);
    }
}

// ============================================
// VIDEO PROCESSING UTILITIES
// ============================================

// Ensure temp directories exist
function ensureTempDirs() {
    if (!fs.existsSync(TEMP_VIDEO_DIR)) {
        fs.mkdirSync(TEMP_VIDEO_DIR, { recursive: true });
    }
    if (!fs.existsSync(CHUNKS_DIR)) {
        fs.mkdirSync(CHUNKS_DIR, { recursive: true });
    }
}

// Get video duration using ffprobe
async function getVideoDuration(videoPath) {
    try {
        const { stdout } = await execAsync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
        );
        return parseFloat(stdout.trim());
    } catch (error) {
        console.error('Error getting video duration:', error);
        throw error;
    }
}

// Get video info (duration, resolution, etc.)
async function getVideoInfo(videoPath) {
    try {
        const { stdout } = await execAsync(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration,codec_name -show_entries format=duration,size -of json "${videoPath}"`
        );
        const info = JSON.parse(stdout);
        return {
            width: info.streams?.[0]?.width,
            height: info.streams?.[0]?.height,
            codec: info.streams?.[0]?.codec_name,
            duration: parseFloat(info.format?.duration || info.streams?.[0]?.duration || 0),
            size: parseInt(info.format?.size || 0)
        };
    } catch (error) {
        console.error('Error getting video info:', error);
        throw error;
    }
}

// Download YouTube video with yt-dlp
async function downloadYouTubeVideo(videoId, quality = '1080', progressCallback = null) {
    ensureTempDirs();

    const outputPath = path.join(TEMP_VIDEO_DIR, `${videoId}.mp4`);

    // Check if already downloaded
    if (fs.existsSync(outputPath)) {
        console.log('Video already downloaded:', outputPath);
        return outputPath;
    }

    // Format selection based on quality
    // We want video + audio merged, max height of specified quality
    const formatString = quality === '1080'
        ? 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best'
        : quality === '720'
        ? 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best'
        : 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best';

    return new Promise((resolve, reject) => {
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const args = [
            '-f', formatString,
            '--merge-output-format', 'mp4',
            '-o', outputPath,
            '--no-playlist',
            '--progress',
            url
        ];

        console.log('Starting download:', url);
        const ytdlp = spawn('yt-dlp', args);

        let lastProgress = 0;

        ytdlp.stdout.on('data', (data) => {
            const output = data.toString();
            console.log('yt-dlp:', output);

            // Parse progress
            const progressMatch = output.match(/(\d+\.?\d*)%/);
            if (progressMatch && progressCallback) {
                const progress = parseFloat(progressMatch[1]);
                if (progress > lastProgress) {
                    lastProgress = progress;
                    progressCallback({ stage: 'download', progress, message: `Downloaden: ${progress.toFixed(1)}%` });
                }
            }
        });

        ytdlp.stderr.on('data', (data) => {
            const output = data.toString();
            console.log('yt-dlp stderr:', output);

            // yt-dlp often outputs progress to stderr
            const progressMatch = output.match(/(\d+\.?\d*)%/);
            if (progressMatch && progressCallback) {
                const progress = parseFloat(progressMatch[1]);
                if (progress > lastProgress) {
                    lastProgress = progress;
                    progressCallback({ stage: 'download', progress, message: `Downloaden: ${progress.toFixed(1)}%` });
                }
            }
        });

        ytdlp.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                console.log('Download complete:', outputPath);
                resolve(outputPath);
            } else {
                reject(new Error(`yt-dlp exited with code ${code}`));
            }
        });

        ytdlp.on('error', (error) => {
            reject(error);
        });
    });
}

// Split video into chunks using ffmpeg
async function splitVideoIntoChunks(videoPath, chunkDurationMinutes = 10, progressCallback = null) {
    ensureTempDirs();

    const videoInfo = await getVideoInfo(videoPath);
    const totalDuration = videoInfo.duration;
    const chunkDurationSeconds = chunkDurationMinutes * 60;
    const numChunks = Math.ceil(totalDuration / chunkDurationSeconds);

    console.log(`Splitting video: ${totalDuration}s into ${numChunks} chunks of ${chunkDurationMinutes} minutes`);

    const videoName = path.basename(videoPath, path.extname(videoPath));
    const chunkDir = path.join(CHUNKS_DIR, videoName);

    // Clean up existing chunks
    if (fs.existsSync(chunkDir)) {
        fs.rmSync(chunkDir, { recursive: true });
    }
    fs.mkdirSync(chunkDir, { recursive: true });

    const chunks = [];

    for (let i = 0; i < numChunks; i++) {
        const startTime = i * chunkDurationSeconds;
        const chunkPath = path.join(chunkDir, `chunk_${String(i + 1).padStart(3, '0')}.mp4`);

        if (progressCallback) {
            progressCallback({
                stage: 'split',
                progress: (i / numChunks) * 100,
                message: `Splitsen: chunk ${i + 1}/${numChunks}`
            });
        }

        // Use ffmpeg to extract chunk without re-encoding (fast)
        // -c copy = copy streams without re-encoding
        // -avoid_negative_ts make_zero = fix timestamp issues
        await execAsync(
            `ffmpeg -y -ss ${startTime} -i "${videoPath}" -t ${chunkDurationSeconds} -c copy -avoid_negative_ts make_zero "${chunkPath}"`,
            { maxBuffer: 50 * 1024 * 1024 }
        );

        // Verify chunk was created
        if (fs.existsSync(chunkPath)) {
            const chunkInfo = await getVideoInfo(chunkPath);
            chunks.push({
                path: chunkPath,
                index: i + 1,
                startTime,
                duration: chunkInfo.duration,
                startTimeFormatted: formatTime(startTime),
                endTimeFormatted: formatTime(startTime + chunkInfo.duration)
            });
            console.log(`Created chunk ${i + 1}: ${chunkPath}`);
        }
    }

    if (progressCallback) {
        progressCallback({ stage: 'split', progress: 100, message: `Splitsen voltooid: ${chunks.length} chunks` });
    }

    return chunks;
}

// Format seconds to HH:MM:SS
function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Retry helper function with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 2000) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            console.error(`Attempt ${attempt}/${maxRetries} failed:`, error.message);

            if (attempt < maxRetries) {
                const delay = baseDelayMs * Math.pow(2, attempt - 1);
                console.log(`Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

// NO compression - keep original 1080p quality for readable code
// Gemini File API can handle larger files
function getChunkForAnalysis(chunkPath) {
    const fileSize = fs.statSync(chunkPath).size;
    console.log(`Using original chunk: ${(fileSize/1024/1024).toFixed(1)}MB (no compression - 1080p required)`);
    return chunkPath;
}

// Upload file to Gemini File API
async function uploadToGeminiFileAPI(filePath, mimeType = 'video/mp4') {
    const apiKey = store.get('geminiApiKey');
    if (!apiKey) throw new Error('Geen Gemini API key');

    const fileBuffer = fs.readFileSync(filePath);
    const fileSizeMB = fileBuffer.length / (1024 * 1024);
    console.log(`Uploading ${fileSizeMB.toFixed(1)}MB to Gemini File API...`);

    // Step 1: Start resumable upload
    const startUploadResponse = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
        {
            method: 'POST',
            headers: {
                'X-Goog-Upload-Protocol': 'resumable',
                'X-Goog-Upload-Command': 'start',
                'X-Goog-Upload-Header-Content-Length': fileBuffer.length.toString(),
                'X-Goog-Upload-Header-Content-Type': mimeType,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                file: { display_name: path.basename(filePath) }
            })
        }
    );

    if (!startUploadResponse.ok) {
        throw new Error(`Upload start failed: ${startUploadResponse.status}`);
    }

    const uploadUrl = startUploadResponse.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) throw new Error('No upload URL received');

    // Step 2: Upload the file bytes
    const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
            'Content-Length': fileBuffer.length.toString(),
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize'
        },
        body: fileBuffer
    });

    if (!uploadResponse.ok) {
        throw new Error(`File upload failed: ${uploadResponse.status}`);
    }

    const fileInfo = await uploadResponse.json();
    console.log(`File uploaded: ${fileInfo.file?.name || 'unknown'}`);

    // Wait for file to be processed
    let fileState = fileInfo.file?.state;
    let fileUri = fileInfo.file?.uri;
    const fileName = fileInfo.file?.name;

    while (fileState === 'PROCESSING') {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const statusResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`
        );
        const statusInfo = await statusResponse.json();
        fileState = statusInfo.state;
        fileUri = statusInfo.uri;
        console.log(`File state: ${fileState}`);
    }

    if (fileState !== 'ACTIVE') {
        throw new Error(`File processing failed: ${fileState}`);
    }

    return { uri: fileUri, mimeType };
}

// Analyze a single video chunk with Gemini
async function analyzeVideoChunk(chunkPath, chunkInfo, analysisType = 'technical-deepdive') {
    if (!genAI) {
        throw new Error('Gemini API niet geconfigureerd');
    }

    const modelName = store.get('geminiModel') || 'gemini-2.5-flash';
    const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
            maxOutputTokens: 8192,
        }
    });

    // Use original quality - no compression (1080p required for code readability)
    const analysisPath = getChunkForAnalysis(chunkPath);

    // Check file size
    const fileStats = fs.statSync(analysisPath);
    const fileSizeMB = fileStats.size / (1024 * 1024);
    console.log(`Chunk ${chunkInfo.index} size: ${fileSizeMB.toFixed(1)}MB`);

    // Upload to Gemini File API (more reliable than inline base64)
    const uploadedFile = await retryWithBackoff(
        () => uploadToGeminiFileAPI(analysisPath, 'video/mp4'),
        3, 5000
    );

    // PURE EXTRACTION - no analysis, just read what's on screen
    const timeContext = `Video segment ${chunkInfo.index} (${chunkInfo.startTimeFormatted} - ${chunkInfo.endTimeFormatted})`;

    const prompt = `${timeContext}

READ AND EXTRACT everything from this video. Output exactly what you see and hear.

## AUDIO
Transcribe word-for-word what the speaker says.

## SCREEN TEXT
Copy ALL text visible on screen exactly as shown:
- File names and paths
- Code (complete, character-for-character)
- Terminal commands and output
- UI labels, menu items, buttons
- Error messages
- Comments

## CODE
For each code block visible:
\`\`\`[language]
[exact code as displayed - every character, every line]
\`\`\`
Filename: [if visible]

## COMMANDS
\`\`\`bash
[exact commands typed]
\`\`\`

Output format: Present the audio transcript alongside what's shown on screen at that moment. Match what is said with what is displayed.

DO NOT:
- Summarize or paraphrase
- Skip any code or text
- Add your own interpretation
- Change any characters in code

ONLY extract and transcribe exactly what you see and hear.`;

    console.log(`Extracting content from chunk ${chunkInfo.index} with Gemini ${modelName}...`);

    // Use File API reference for analysis (more reliable than base64)
    return await retryWithBackoff(async () => {
        const result = await model.generateContent([
            {
                fileData: {
                    mimeType: uploadedFile.mimeType,
                    fileUri: uploadedFile.uri
                }
            },
            { text: prompt }
        ]);

        const response = await result.response;
        return response.text();
    }, 3, 5000); // 3 retries, starting with 5 second delay
}

// Merge all chunk analyses into final document
function mergeChunkAnalyses(analyses, videoTitle, videoInfo) {
    const header = `# Complete Video Analyse: ${videoTitle}

## Video Informatie
- **Duur:** ${formatTime(videoInfo.duration)}
- **Resolutie:** ${videoInfo.width}x${videoInfo.height}
- **Aantal segmenten geanalyseerd:** ${analyses.length}
- **Analyse datum:** ${new Date().toLocaleString('nl-NL')}

---

`;

    let body = '';
    analyses.forEach((analysis, index) => {
        body += `\n\n# SEGMENT ${index + 1} (${analysis.chunkInfo.startTimeFormatted} - ${analysis.chunkInfo.endTimeFormatted})\n\n`;
        body += analysis.content;
        body += '\n\n---';
    });

    // Add consolidated sections at the end
    const footer = `

# SAMENVATTING & GECONSOLIDEERDE CODE

De bovenstaande segmenten bevatten alle geëxtraheerde code en uitleg uit de video.
Gebruik de timestamps om specifieke secties in de originele video terug te vinden.

## Tips voor Implementatie
1. Volg de code in chronologische volgorde
2. Let op dependencies die genoemd worden
3. Check de gesproken uitleg voor context die niet in de code staat

---
*Geanalyseerd met Brain App + Gemini AI*
`;

    return header + body + footer;
}

// Clean up temp files for a video
function cleanupVideoFiles(videoId) {
    const videoPath = path.join(TEMP_VIDEO_DIR, `${videoId}.mp4`);
    const chunkDir = path.join(CHUNKS_DIR, videoId);

    if (fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
    }
    if (fs.existsSync(chunkDir)) {
        fs.rmSync(chunkDir, { recursive: true });
    }
}

let mainWindow;

// ============================================
// SINGLE INSTANCE LOCK
// ============================================
// Zorgt ervoor dat er maar één venster/instantie van de app kan draaien
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    // Er draait al een instantie, sluit deze nieuwe
    console.log('Brain App draait al - focus bestaande instantie');
    app.quit();
} else {
    // Deze is de eerste/enige instantie
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Iemand probeerde een tweede instantie te starten
        // Focus het bestaande venster
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
            console.log('Tweede instantie geblokkeerd - bestaand venster gefocust');
        }
    });
}

function createWindow() {
    // Voorkom dubbele vensters
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
        return;
    }

    const bounds = store.get('windowBounds');

    mainWindow = new BrowserWindow({
        width: bounds.width,
        height: bounds.height,
        minWidth: 1000,
        minHeight: 700,
        titleBarStyle: 'hiddenInset', // macOS style
        backgroundColor: '#0f0f1a',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile('renderer/index.html');

    // Save window size on resize
    mainWindow.on('resize', () => {
        const { width, height } = mainWindow.getBounds();
        store.set('windowBounds', { width, height });
    });

    // Open DevTools in dev mode
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }
}

// Alleen starten als we de single instance lock hebben
if (gotTheLock) {
    app.whenReady().then(async () => {
        console.log('Brain App starting...');
        await initializeApp();
        createWindow();

        app.on('activate', () => {
            // macOS: heropen venster als er op dock icon geklikt wordt
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            } else if (mainWindow) {
                mainWindow.focus();
            }
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });
}

// ============================================
// IPC HANDLERS - Configuration
// ============================================

// Get app configuration
ipcMain.handle('get-config', () => {
    return {
        obsidianVaultPath: store.get('obsidianVaultPath'),
        videos: store.get('videos'),
        analyses: store.get('analyses')
    };
});

// Save configuration
ipcMain.handle('save-config', (event, config) => {
    Object.keys(config).forEach(key => {
        store.set(key, config[key]);
    });
    return true;
});

// Select Obsidian vault folder
ipcMain.handle('select-obsidian-vault', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Selecteer je Obsidian Vault'
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const vaultPath = result.filePaths[0];
        store.set('obsidianVaultPath', vaultPath);
        return vaultPath;
    }
    return null;
});

// ============================================
// IPC HANDLERS - File System Operations
// ============================================

// Read file from filesystem
ipcMain.handle('read-file', async (event, filePath) => {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return { success: true, content };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Write file to filesystem
ipcMain.handle('write-file', async (event, { filePath, content }) => {
    try {
        // Ensure directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, content, 'utf-8');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// List files in directory
ipcMain.handle('list-files', async (event, dirPath) => {
    try {
        const files = fs.readdirSync(dirPath, { withFileTypes: true });
        return {
            success: true,
            files: files.map(f => ({
                name: f.name,
                isDirectory: f.isDirectory(),
                path: path.join(dirPath, f.name)
            }))
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Check if path exists
ipcMain.handle('path-exists', async (event, filePath) => {
    return fs.existsSync(filePath);
});

// ============================================
// IPC HANDLERS - Obsidian Integration
// ============================================

// Save analysis to Obsidian vault
ipcMain.handle('save-to-obsidian', async (event, { filename, content, subfolder }) => {
    try {
        const vaultPath = store.get('obsidianVaultPath');
        if (!vaultPath) {
            return { success: false, error: 'Obsidian vault niet geconfigureerd' };
        }

        let targetDir = path.join(vaultPath, '_Brain', 'Video-Analysis');
        if (subfolder) {
            targetDir = path.join(targetDir, subfolder);
        }

        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const filePath = path.join(targetDir, filename);
        fs.writeFileSync(filePath, content, 'utf-8');

        return { success: true, path: filePath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Open file in default application
ipcMain.handle('open-external', async (event, filePath) => {
    shell.openPath(filePath);
});

// Open URL in browser
ipcMain.handle('open-url', async (event, url) => {
    shell.openExternal(url);
});

// Restart app
ipcMain.handle('restart-app', async () => {
    // Check if there are running processes
    if (runningClaudeProcesses.size > 0) {
        const processes = Array.from(runningClaudeProcesses.values());
        const processNames = processes.map(p => p.name).join(', ');

        const result = await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            buttons: ['Wacht', 'Toch Herstarten', 'Annuleren'],
            defaultId: 0,
            cancelId: 2,
            title: 'Lopende Processen',
            message: `Er zijn ${runningClaudeProcesses.size} lopende analyse(s)`,
            detail: `De volgende processen zijn nog bezig:\n\n${processNames}\n\nWil je wachten tot deze klaar zijn, of toch herstarten (processen worden onderbroken)?`
        });

        if (result.response === 0) {
            // User chose to wait
            return { cancelled: true, reason: 'waiting' };
        } else if (result.response === 2) {
            // User cancelled
            return { cancelled: true, reason: 'cancelled' };
        }
        // User chose to restart anyway - kill processes
        for (const [pid] of runningClaudeProcesses) {
            try {
                process.kill(pid, 'SIGTERM');
            } catch (e) {
                console.log('Process already ended:', pid);
            }
        }
        runningClaudeProcesses.clear();
    }

    app.relaunch();
    app.exit(0);
});

// IPC: Check if processes are running
ipcMain.handle('check-running-processes', async () => {
    return {
        count: runningClaudeProcesses.size,
        processes: Array.from(runningClaudeProcesses.values())
    };
});

// Select file dialog
ipcMain.handle('select-file', async (event, extensions) => {
    const filters = [];
    if (extensions && extensions.length > 0) {
        filters.push({ name: 'Files', extensions: extensions });
    }
    filters.push({ name: 'All Files', extensions: ['*'] });

    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: filters
    });

    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

// Select multiple files dialog
ipcMain.handle('select-files', async (event, extensions) => {
    const filters = [];
    if (extensions && extensions.length > 0) {
        filters.push({ name: 'Files', extensions: extensions });
    }
    filters.push({ name: 'All Files', extensions: ['*'] });

    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: filters
    });

    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths;
    }
    return [];
});

// ============================================
// IPC HANDLERS - Document Analysis
// ============================================

// Analyze documents with Gemini
ipcMain.handle('analyze-documents', async (event, { files, analysisType, persona, goal, goalType, extraInstructions, generateClaudePrompt }) => {
    try {
        if (!genAI) {
            return { success: false, error: 'Gemini API key niet geconfigureerd. Ga naar Settings.' };
        }

        if (!files || files.length === 0) {
            return { success: false, error: 'Geen documenten geselecteerd' };
        }

        console.log(`Analyzing ${files.length} documents with Gemini...`);

        const modelName = store.get('geminiModel') || 'gemini-2.5-flash';
        const model = genAI.getGenerativeModel({ model: modelName });

        // Read all document contents
        let combinedContent = '';
        const fileContents = [];

        for (const filePath of files) {
            const fileName = path.basename(filePath);
            const ext = path.extname(filePath).toLowerCase();

            let content = '';
            try {
                if (ext === '.pdf') {
                    // For PDF, we'll send as binary to Gemini
                    const buffer = fs.readFileSync(filePath);
                    fileContents.push({
                        type: 'pdf',
                        name: fileName,
                        data: buffer.toString('base64')
                    });
                    combinedContent += `\n\n--- DOCUMENT: ${fileName} (PDF) ---\n[PDF content wordt visueel geanalyseerd]\n`;
                } else {
                    // Text-based files
                    content = fs.readFileSync(filePath, 'utf-8');
                    fileContents.push({
                        type: 'text',
                        name: fileName,
                        content: content
                    });
                    combinedContent += `\n\n--- DOCUMENT: ${fileName} ---\n${content}\n`;
                }
            } catch (err) {
                console.error(`Error reading ${fileName}:`, err);
                combinedContent += `\n\n--- DOCUMENT: ${fileName} ---\n[Kon niet worden gelezen: ${err.message}]\n`;
            }
        }

        // Build the analysis prompt based on persona, goal, and type
        let prompt = `Je bent een expert AI assistent die documenten analyseert voor professionals.

## CONTEXT
- **Mijn rol/expertise**: ${persona}
- **Mijn doel**: ${goal}

## DOCUMENTEN OM TE ANALYSEREN
${combinedContent}

${extraInstructions ? `## EXTRA INSTRUCTIES\n${extraInstructions}\n\n` : ''}

## VERPLICHTE OUTPUT FORMAT

**EERST: Genereer een SLIMME TITEL**
Begin je antwoord ALTIJD met:
TITEL: [Max 60 karakters - beschrijvende titel van wat deze documenten behandelen]

Daarna volgt de analyse:
`;

        // Add analysis-type specific instructions
        if (analysisType === 'technical') {
            prompt += `ANALYSE TYPE: Technische Deep-Dive

Maak een COMPLETE technische analyse:

## 1. OVERZICHT
- Wat beschrijven deze documenten
- Hoofdonderwerpen en scope

## 2. TECHNISCHE SPECIFICATIES
- Alle technische requirements
- Architectuur details
- Data modellen / schemas
- API's en interfaces

## 3. IMPLEMENTATIE DETAILS
- Code voorbeelden (indien aanwezig)
- Configuraties
- Dependencies

## 4. KEY DECISIONS
- Belangrijke keuzes die gemaakt zijn
- Trade-offs en overwegingen

## 5. ACTIEPUNTEN
- Wat moet er gebouwd/gedaan worden
- In welke volgorde`;
        } else if (analysisType === 'summary') {
            prompt += `ANALYSE TYPE: Samenvatting

Maak een duidelijke, gestructureerde samenvatting:

## KERN BOODSCHAP
- Waar gaat dit over (1-2 zinnen)

## HOOFDPUNTEN
- Bullet points van de belangrijkste informatie

## DETAILS PER SECTIE
- Korte samenvatting per document/sectie

## CONCLUSIE
- Belangrijkste takeaways`;
        } else if (analysisType === 'readable' || analysisType === 'student') {
            prompt += `ANALYSE TYPE: Leesbare Analyse (Student-vriendelijk)

BELANGRIJK: Schrijf je analyse in GEWONE, LEESBARE NEDERLANDSE TEKST.
- GEEN code blocks of JSON
- GEEN technische markdown formatting
- Schrijf in volledige zinnen en paragrafen
- Maak het geschikt voor PDF export

Structureer je analyse als volgt:

SAMENVATTING
Schrijf een heldere samenvatting van 2-3 alinea's over wat dit document behandelt.

KERNBEVINDINGEN
Beschrijf de belangrijkste punten in gewone tekst, niet als bullets of lijsten.
Leg elk punt uit in 2-3 zinnen zodat het begrijpelijk is.

DETAILS EN UITLEG
Ga dieper in op de belangrijkste onderwerpen. Schrijf dit als een samenhangend verhaal,
niet als losse opsommingen. Gebruik tussenkopjes waar nodig, maar geen nummering.

PRAKTISCHE TOEPASSINGEN
Leg uit hoe deze informatie gebruikt kan worden. Schrijf dit in normale paragrafen.

CONCLUSIE
Vat de belangrijkste lessen samen in 1-2 alinea's.

BELANGRIJK: Vermijd volledig:
- JSON structuren of code
- Markdown tabellen
- Geneste lijsten met technische formatting
- Code blocks (\`\`\`)
Schrijf alles als gewone, vloeiende tekst.`;
        } else if (analysisType === 'implementation') {
            prompt += `ANALYSE TYPE: Implementatie Plan voor App-Bouw

Maak een VOLLEDIG ACTIEGERICHT implementatieplan dat direct naar Claude Code CLI kan:

## 1. PROJECT DEFINITIE
- **Naam**: [Korte projectnaam]
- **Doel**: [Wat doet de app - 1 zin]
- **Hoofdfeatures**: [Bullet list van 3-5 features]
- **Platform**: [Web/Desktop/Mobile/API]

## 2. TECHNOLOGIE STACK (CONCREET)
| Component | Technologie | Reden |
|-----------|------------|-------|
| Frontend | [bv. React/Vue/Next.js] | [waarom] |
| Backend | [bv. Node/Python/Go] | [waarom] |
| Database | [bv. PostgreSQL/MongoDB] | [waarom] |
| Deployment | [bv. Docker/Vercel] | [waarom] |

## 3. DATA MODEL
\`\`\`
[Schema/ERD in tekst of pseudo-code]
\`\`\`

## 4. API ENDPOINTS (indien van toepassing)
| Endpoint | Method | Beschrijving |
|----------|--------|-------------|
| /api/... | GET/POST | ... |

## 5. STAP-VOOR-STAP IMPLEMENTATIE

### Stap 1: Project Setup
\`\`\`bash
[Exacte commando's om te starten]
\`\`\`

### Stap 2: Core Structuur
\`\`\`
[Folder structuur]
\`\`\`

### Stap 3-N: Features
[Per feature: wat, hoe, code snippets]

## 6. ENVIRONMENT VARIABLES
\`\`\`env
[Alle benodigde env vars]
\`\`\`

## 7. TESTING CHECKLIST
- [ ] [Test 1]
- [ ] [Test 2]

## 8. DEPLOYMENT
[Concrete deployment stappen]`;
        }

        // If Claude Code prompt generation is requested, add that section
        if (generateClaudePrompt || goalType === 'claude-prompt') {
            prompt += `

## CLAUDE CODE CLI PROMPT
Genereer een kant-en-klare prompt die direct in Claude Code CLI gebruikt kan worden om dit project te bouwen.

De prompt moet:
1. Beginnen met een duidelijke opdracht
2. Alle specificaties bevatten
3. De gewenste technologieën specificeren
4. Concrete deliverables benoemen
5. In het Nederlands zijn

Format:
\`\`\`
[De complete Claude Code prompt hier]
\`\`\``;
        }

        console.log('Sending documents to Gemini for analysis...');

        // Build content parts for Gemini
        const contentParts = [];

        // Add PDF files as inline data if any
        for (const file of fileContents) {
            if (file.type === 'pdf') {
                contentParts.push({
                    inlineData: {
                        mimeType: 'application/pdf',
                        data: file.data
                    }
                });
            }
        }

        // Add the text prompt
        contentParts.push({ text: prompt });

        const result = await model.generateContent(contentParts);
        const response = await result.response;
        let analysisText = response.text();

        // Extract AI-generated title from response
        let generatedTitle = null;
        const titleMatch = analysisText.match(/^TITEL:\s*(.+)$/m);
        if (titleMatch) {
            generatedTitle = titleMatch[1].trim().substring(0, 60);
            // Remove the TITEL line from the analysis
            analysisText = analysisText.replace(/^TITEL:\s*.+\n*/m, '').trim();
        }

        // Extract Claude prompt if generated
        let claudePrompt = null;
        if (generateClaudePrompt || goalType === 'claude-prompt') {
            // Find the Claude Code CLI Prompt section and extract code block
            const claudeSection = analysisText.match(/## CLAUDE CODE CLI PROMPT[\s\S]*?```\n?([\s\S]*?)\n?```/);
            if (claudeSection) {
                claudePrompt = claudeSection[1].trim();
            } else {
                // Fallback to first code block if specific section not found
                const promptMatch = analysisText.match(/```\n?([\s\S]*?)\n?```/);
                if (promptMatch) {
                    claudePrompt = promptMatch[1].trim();
                }
            }
        }

        console.log('Document analysis complete. Generated title:', generatedTitle);

        return {
            success: true,
            analysis: analysisText,
            generatedTitle: generatedTitle,
            claudePrompt: claudePrompt,
            filesAnalyzed: files.length,
            model: modelName,
            analysisType,
            persona,
            goalType
        };

    } catch (error) {
        console.error('Document analysis error:', error);
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC HANDLERS - Claude Code CLI Export
// ============================================

ipcMain.handle('export-to-claude-code', async (event, { title, analysis, claudePrompt, filePaths, persona, goalType, date }) => {
    try {
        // Create project directory name from title
        const safeName = (title || 'brain-project')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 50);

        const projectDir = path.join(app.getPath('documents'), 'Claude-Code-Projects', `${safeName}-${Date.now()}`);

        // Create directory structure
        fs.mkdirSync(projectDir, { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });

        // Copy original documents
        if (filePaths && filePaths.length > 0) {
            for (const filePath of filePaths) {
                if (fs.existsSync(filePath)) {
                    const fileName = path.basename(filePath);
                    fs.copyFileSync(filePath, path.join(projectDir, 'docs', fileName));
                }
            }
        }

        // Create CLAUDE.md with project instructions
        const claudeMd = `# ${title}

## Project Context
- **Gegenereerd door**: Brain App
- **Datum**: ${date || new Date().toLocaleDateString('nl-NL')}
- **Persona**: ${persona || 'Software Developer'}
- **Doel**: ${goalType || 'Implementatie'}

## Instructies voor Claude

Dit project is gegenereerd vanuit Brain App document analyse.

### Belangrijke bestanden:
- \`PROJECT_CONTEXT.md\` - Volledige analyse van de bronmaterialen
- \`docs/\` - Originele documenten
${claudePrompt ? '- `PROMPT.txt` - Specifieke implementatie prompt' : ''}

### Workflow:
1. Lees eerst PROJECT_CONTEXT.md voor volledige context
2. Bekijk de originele documenten in /docs/
${claudePrompt ? '3. Gebruik PROMPT.txt als startpunt voor implementatie' : ''}

### Regels:
- Volg de technische specificaties uit de analyse
- Vraag om verduidelijking bij onduidelijkheden
- Maak incrementele commits met duidelijke messages
`;

        fs.writeFileSync(path.join(projectDir, '.claude', 'CLAUDE.md'), claudeMd, 'utf-8');
        // Also create at root for visibility
        fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), claudeMd, 'utf-8');

        // Create PROJECT_CONTEXT.md with full analysis
        const contextMd = `# Project Context: ${title}

## Metadata
- **Bron**: Brain App Document Analyse
- **Datum**: ${date || new Date().toLocaleDateString('nl-NL')}
- **Persona**: ${persona || 'Software Developer'}
- **Analyse Type**: ${goalType || 'Implementatie'}

---

## Volledige Analyse

${analysis || 'Geen analyse beschikbaar.'}

---

## Originele Documenten

De volgende documenten zijn geanalyseerd:
${filePaths && filePaths.length > 0 ? filePaths.map(f => `- \`docs/${path.basename(f)}\``).join('\n') : '- Geen documenten'}
`;

        fs.writeFileSync(path.join(projectDir, 'PROJECT_CONTEXT.md'), contextMd, 'utf-8');

        // Create PROMPT.txt if Claude prompt is available
        let claudePromptFile = false;
        if (claudePrompt) {
            const promptTxt = `# Claude Code CLI Prompt

Kopieer onderstaande prompt en plak in Claude Code CLI:

---

${claudePrompt}

---

Tip: Je kunt dit direct gebruiken met:
cat PROMPT.txt | claude
`;
            fs.writeFileSync(path.join(projectDir, 'PROMPT.txt'), promptTxt, 'utf-8');
            claudePromptFile = true;
        }

        // Create a simple README
        const readme = `# ${title}

Dit project is gegenereerd door Brain App.

## Quick Start

\`\`\`bash
cd "${projectDir}"
claude
\`\`\`

Dan kun je Claude vragen om het project te bouwen op basis van de context.

## Structuur

- \`CLAUDE.md\` - Instructies voor Claude
- \`PROJECT_CONTEXT.md\` - Volledige analyse
- \`docs/\` - Originele bronmaterialen
${claudePromptFile ? '- `PROMPT.txt` - Kant-en-klare prompt' : ''}
`;

        fs.writeFileSync(path.join(projectDir, 'README.md'), readme, 'utf-8');

        console.log(`Project exported to: ${projectDir}`);

        return {
            success: true,
            projectPath: projectDir,
            claudePromptFile: claudePromptFile
        };

    } catch (error) {
        console.error('Export error:', error);
        return { success: false, error: error.message };
    }
});

// ============================================
// CLAUDE CODE CLI INTEGRATION
// ============================================

// Active Claude processes
const activeClaudeProcesses = new Map();

// Check if Claude CLI is available
async function checkClaudeCLI() {
    try {
        const { stdout } = await execAsync('which claude');
        return { available: true, path: stdout.trim() };
    } catch (error) {
        return { available: false, path: null };
    }
}

// IPC: Check Claude CLI availability
ipcMain.handle('check-claude-cli', async () => {
    return await checkClaudeCLI();
});

// IPC: Get system stats (CPU & Memory)
ipcMain.handle('get-system-stats', async () => {
    const os = require('os');

    // Memory stats
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    // CPU stats - calculate from load average (macOS/Linux)
    const loadAvg = os.loadavg()[0]; // 1 minute average
    const cpuCount = os.cpus().length;
    const cpuPercent = Math.min(100, Math.round((loadAvg / cpuCount) * 100));

    return {
        cpu: cpuPercent,
        memory: memPercent,
        memUsedGB: (usedMem / 1024 / 1024 / 1024).toFixed(1),
        memTotalGB: (totalMem / 1024 / 1024 / 1024).toFixed(1),
        loadAvg: loadAvg.toFixed(2),
        cpuCount
    };
});

// IPC: Run Claude Code CLI Agent
ipcMain.handle('run-claude-agent', async (event, {
    prompt,
    projectPath,
    allowedTools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    permissionMode = 'default',
    sessionId = null
}) => {
    try {
        // Check CLI availability
        const cliCheck = await checkClaudeCLI();
        if (!cliCheck.available) {
            return {
                success: false,
                error: 'Claude Code CLI niet gevonden. Installeer met: npm install -g @anthropic-ai/claude-code'
            };
        }

        // Build command arguments
        // Note: --verbose is REQUIRED when using --output-format stream-json with -p
        const args = [
            '-p', prompt,
            '--allowedTools', allowedTools.join(','),
            '--output-format', 'stream-json',
            '--verbose',
            '--permission-mode', permissionMode === 'bypass' ? 'bypassPermissions' : permissionMode,
            '--no-session-persistence'  // Don't save sessions for automated analyses
        ];

        // Add session resume if provided
        if (sessionId) {
            args.push('--resume', sessionId);
        }

        // Set working directory
        const cwd = projectPath || app.getPath('documents');

        console.log(`Running Claude CLI in: ${cwd}`);
        console.log(`Args: ${args.join(' ')}`);

        // Spawn Claude process using full path to avoid shell issues
        const claudePath = '/opt/homebrew/bin/claude';
        const claudeProcess = spawn(claudePath, args, {
            cwd: cwd,
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const processId = `claude-${Date.now()}`;
        activeClaudeProcesses.set(processId, claudeProcess);

        // CRITICAL: Close stdin to signal no more input - without this, Claude CLI waits forever
        claudeProcess.stdin.end();

        let fullResult = '';
        let lastSessionId = null;
        let stdoutBuffer = '';  // Buffer for incomplete lines
        let lineCount = 0;

        // Use direct stdout.on('data') instead of readline for better streaming
        claudeProcess.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            stdoutBuffer += text;

            // Process complete lines (split by newline)
            const lines = stdoutBuffer.split('\n');
            // Keep the last incomplete line in buffer
            stdoutBuffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                lineCount++;
                console.log(`Claude stdout line ${lineCount}:`, line.substring(0, 100));

                try {
                    const message = JSON.parse(line);

                    // Extract session ID if present
                    if (message.session_id) {
                        lastSessionId = message.session_id;
                    }

                    // Send to renderer
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('claude-stream', {
                            processId,
                            type: message.type || 'message',
                            data: message
                        });
                    }

                    // Collect text output
                    if (message.type === 'assistant' && message.message?.content) {
                        const textContent = message.message.content
                            .filter(c => c.type === 'text')
                            .map(c => c.text)
                            .join('');
                        fullResult += textContent;
                    }
                } catch (e) {
                    // Non-JSON line, might be regular output
                    console.log('Non-JSON line:', line.substring(0, 50));
                    fullResult += line + '\n';
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('claude-stream', {
                            processId,
                            type: 'text',
                            data: line
                        });
                    }
                }
            }
        });

        // Handle stderr
        claudeProcess.stderr.on('data', (data) => {
            const errorText = data.toString();
            console.error('Claude stderr:', errorText);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('claude-stream', {
                    processId,
                    type: 'error',
                    data: errorText
                });
            }
        });

        // Wait for process to complete
        return new Promise((resolve) => {
            claudeProcess.on('close', (code) => {
                // Process any remaining buffer content
                if (stdoutBuffer.trim()) {
                    console.log('Processing remaining buffer:', stdoutBuffer.substring(0, 50));
                    try {
                        const message = JSON.parse(stdoutBuffer);
                        if (message.type === 'assistant' && message.message?.content) {
                            const textContent = message.message.content
                                .filter(c => c.type === 'text')
                                .map(c => c.text)
                                .join('');
                            fullResult += textContent;
                        }
                    } catch (e) {
                        fullResult += stdoutBuffer + '\n';
                    }
                }

                activeClaudeProcesses.delete(processId);
                console.log(`Claude process closed with code ${code}, total lines: ${lineCount}`);

                const result = {
                    success: code === 0,
                    processId,
                    exitCode: code,
                    result: fullResult,
                    output: fullResult, // Alias for compatibility
                    sessionId: lastSessionId
                };

                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('claude-complete', result);
                }

                resolve(result);
            });

            claudeProcess.on('error', (error) => {
                activeClaudeProcesses.delete(processId);
                resolve({
                    success: false,
                    processId,
                    error: error.message
                });
            });
        });

    } catch (error) {
        console.error('Claude agent error:', error);
        return { success: false, error: error.message };
    }
});

// IPC: Stop Claude process
ipcMain.handle('stop-claude-agent', async (event, { processId }) => {
    const process = activeClaudeProcesses.get(processId);
    if (process) {
        process.kill('SIGTERM');
        activeClaudeProcesses.delete(processId);
        return { success: true };
    }
    return { success: false, error: 'Process niet gevonden' };
});

// IPC: Run Claude with project context (combines export + run)
ipcMain.handle('run-claude-with-context', async (event, {
    title,
    analysis,
    claudePrompt,
    filePaths,
    persona,
    goalType,
    buildInstructions
}) => {
    console.log('=== run-claude-with-context called ===');
    console.log('Title:', title);
    console.log('Files:', filePaths);
    console.log('Prompt:', claudePrompt);

    try {

        // Create project path
        const safeName = (title || 'brain-project')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 50);

        const projectDir = path.join(app.getPath('documents'), 'Claude-Code-Projects', `${safeName}-${Date.now()}`);

        // Create directory structure
        fs.mkdirSync(projectDir, { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });

        // Copy documents
        if (filePaths && filePaths.length > 0) {
            for (const filePath of filePaths) {
                if (fs.existsSync(filePath)) {
                    const fileName = path.basename(filePath);
                    fs.copyFileSync(filePath, path.join(projectDir, 'docs', fileName));
                }
            }
        }

        // Create CLAUDE.md with instructions
        const claudeMd = `# ${title}

## Project Context
- **Persona**: ${persona || 'Software Developer'}
- **Doel**: ${goalType || 'Implementatie'}

## Instructies
${buildInstructions || claudePrompt || 'Bouw een applicatie op basis van de documenten in /docs/'}

## Analyse
${analysis ? analysis.substring(0, 5000) : 'Geen analyse beschikbaar.'}

## Bronbestanden
${filePaths ? filePaths.map(f => `- docs/${path.basename(f)}`).join('\n') : 'Geen documenten'}
`;
        fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), claudeMd, 'utf-8');

        // Build the prompt for Claude
        const fullPrompt = buildInstructions || claudePrompt ||
            `Lees CLAUDE.md en de documenten in /docs/. Bouw vervolgens een werkende applicatie op basis van de specificaties.`;

        // Now run Claude in this project
        const cliCheck = await checkClaudeCLI();
        if (!cliCheck.available) {
            return {
                success: false,
                error: 'Claude Code CLI niet gevonden',
                projectPath: projectDir
            };
        }

        // Run Claude CLI in the project directory
        // Note: --verbose is REQUIRED when using --output-format stream-json with -p
        const args = [
            '-p', fullPrompt,
            '--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep',
            '--output-format', 'stream-json',
            '--verbose',
            '--permission-mode', 'bypassPermissions',
            '--no-session-persistence'
        ];

        console.log(`Running Claude CLI in: ${projectDir}`);
        console.log(`Args: ${args.join(' ')}`);

        console.log('Spawning Claude CLI process...');

        // Use full path to claude
        const claudePath = '/opt/homebrew/bin/claude';

        // IMPORTANT: Use shell: false and detached: false to ensure stdio is properly piped
        // Also inherit PATH to ensure node can find dependencies
        const claudeProcess = spawn(claudePath, args, {
            cwd: projectDir,
            env: {
                ...process.env,
                // Ensure PATH includes homebrew
                PATH: `/opt/homebrew/bin:${process.env.PATH}`
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            detached: false
        });

        // Log if process failed to start
        if (!claudeProcess.pid) {
            console.error('Failed to spawn Claude CLI process');
            return {
                success: false,
                error: 'Failed to spawn Claude CLI process',
                projectPath: projectDir
            };
        }

        // CRITICAL: Close stdin to signal no more input - without this, Claude CLI waits forever
        claudeProcess.stdin.end();

        console.log('Claude CLI process spawned, PID:', claudeProcess.pid);

        // Register running process for restart warning
        runningClaudeProcesses.set(claudeProcess.pid, {
            name: title || 'Claude Analyse',
            startTime: Date.now()
        });

        const rl = readline.createInterface({
            input: claudeProcess.stdout,
            crlfDelay: Infinity
        });

        let fullResult = '';
        let lineCount = 0;
        let lastActivity = Date.now();

        rl.on('line', (line) => {
            lineCount++;
            lastActivity = Date.now();
            console.log(`Claude output line ${lineCount}:`, line.substring(0, 100) + (line.length > 100 ? '...' : ''));

            try {
                const message = JSON.parse(line);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('claude-stream', {
                        type: message.type || 'message',
                        data: message
                    });
                }
                if (message.type === 'assistant' && message.message?.content) {
                    const textContent = message.message.content
                        .filter(c => c.type === 'text')
                        .map(c => c.text)
                        .join('');
                    fullResult += textContent;
                }
            } catch (e) {
                fullResult += line + '\n';
            }
        });

        // NOTE: Don't add separate stdout.on('data') listener - it conflicts with readline
        // The readline interface handles stdout parsing

        claudeProcess.stderr.on('data', (data) => {
            lastActivity = Date.now();
            const stderr = data.toString();
            console.error('Claude stderr:', stderr);
            // Send stderr to renderer for debugging
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('claude-stream', {
                    type: 'stderr',
                    content: stderr
                });
            }
        });

        // Timeout after 5 minutes of no activity
        const TIMEOUT_MS = 5 * 60 * 1000;
        const timeoutChecker = setInterval(() => {
            if (Date.now() - lastActivity > TIMEOUT_MS) {
                console.log('Claude CLI timeout - no activity for 5 minutes');
                claudeProcess.kill('SIGTERM');
                clearInterval(timeoutChecker);
            }
        }, 30000);

        return new Promise((resolve) => {
            claudeProcess.on('close', (code) => {
                clearInterval(timeoutChecker);
                // Remove from running processes
                runningClaudeProcesses.delete(claudeProcess.pid);
                console.log(`Claude CLI process closed with code: ${code}, lines received: ${lineCount}`);
                resolve({
                    success: code === 0,
                    projectPath: projectDir,
                    output: fullResult,
                    result: fullResult,
                    exitCode: code,
                    linesReceived: lineCount
                });
            });
            claudeProcess.on('error', (error) => {
                clearInterval(timeoutChecker);
                // Remove from running processes
                runningClaudeProcesses.delete(claudeProcess.pid);
                console.error('Claude CLI process error:', error);
                resolve({
                    success: false,
                    projectPath: projectDir,
                    error: error.message
                });
            });
        });

    } catch (error) {
        console.error('Claude with context error:', error);
        return { success: false, error: error.message };
    }
});

// IPC: Open project folder
ipcMain.handle('open-project-folder', async (event, { projectPath }) => {
    if (fs.existsSync(projectPath)) {
        shell.openPath(projectPath);
        return { success: true };
    }
    return { success: false, error: 'Map niet gevonden' };
});

// IPC: Open terminal in project folder
ipcMain.handle('open-terminal-in-project', async (event, { projectPath }) => {
    if (!fs.existsSync(projectPath)) {
        return { success: false, error: 'Map niet gevonden' };
    }

    try {
        // macOS: Open Terminal.app
        if (process.platform === 'darwin') {
            await execAsync(`open -a Terminal "${projectPath}"`);
        }
        // Windows: Open cmd
        else if (process.platform === 'win32') {
            await execAsync(`start cmd /K "cd /d ${projectPath}"`);
        }
        // Linux: Try common terminals
        else {
            await execAsync(`x-terminal-emulator --working-directory="${projectPath}" || gnome-terminal --working-directory="${projectPath}"`);
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC HANDLERS - Full Video Analysis (Download + Split + Analyze)
// ============================================

// Full YouTube video analysis with chunking
ipcMain.handle('analyze-youtube-full', async (event, { url, analysisType = 'extraction', quality = '1080', chunkMinutes = 3 }) => {
    try {
        if (!genAI) {
            return { success: false, error: 'Gemini API key niet geconfigureerd. Ga naar Settings.' };
        }

        const videoId = extractYouTubeId(url);
        if (!videoId) {
            return { success: false, error: 'Ongeldige YouTube URL' };
        }

        // Prevent duplicate analyses
        if (runningVideoAnalyses.has(videoId)) {
            const existingAnalysis = runningVideoAnalyses.get(videoId);
            const runningTime = Date.now() - existingAnalysis.startTime;
            console.log(`Analysis for ${videoId} already running for ${Math.round(runningTime/1000)}s`);

            // If running for more than 10 minutes, allow restart
            if (runningTime < 600000) {
                return { success: false, error: 'Deze video wordt al geanalyseerd. Even geduld...' };
            }
        }

        // Mark as running
        runningVideoAnalyses.set(videoId, { startTime: Date.now() });

        // Get video title
        let videoTitle = '';
        try {
            const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
            videoTitle = await new Promise((resolve) => {
                https.get(oembedUrl, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            resolve(json.title || `Video ${videoId}`);
                        } catch (e) {
                            resolve(`Video ${videoId}`);
                        }
                    });
                }).on('error', () => resolve(`Video ${videoId}`));
            });
        } catch (e) {
            videoTitle = `Video ${videoId}`;
        }

        console.log(`Starting full analysis of: ${videoTitle}`);

        // Progress callback to send updates to renderer
        const sendProgress = (progress) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('analysis-progress', progress);
            }
        };

        // Step 1: Download video
        sendProgress({ stage: 'download', progress: 0, message: 'Video downloaden...' });
        const videoPath = await downloadYouTubeVideo(videoId, quality, sendProgress);

        // Step 2: Get video info
        const videoInfo = await getVideoInfo(videoPath);
        console.log('Video info:', videoInfo);

        // Step 3: Split into chunks
        sendProgress({ stage: 'split', progress: 0, message: 'Video splitsen in segmenten...' });
        const chunks = await splitVideoIntoChunks(videoPath, chunkMinutes, sendProgress);
        console.log(`Created ${chunks.length} chunks`);

        // Step 4: Analyze each chunk
        const analyses = [];
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            sendProgress({
                stage: 'analyze',
                progress: (i / chunks.length) * 100,
                message: `Analyseren: segment ${i + 1}/${chunks.length} (${chunk.startTimeFormatted})`,
                currentChunk: i + 1,
                totalChunks: chunks.length
            });

            try {
                const analysisContent = await analyzeVideoChunk(chunk.path, chunk, analysisType);
                analyses.push({
                    chunkInfo: chunk,
                    content: analysisContent
                });
                console.log(`Chunk ${i + 1} analysis complete`);
            } catch (error) {
                console.error(`Error analyzing chunk ${i + 1}:`, error);
                analyses.push({
                    chunkInfo: chunk,
                    content: `[Fout bij analyseren van dit segment: ${error.message}]`
                });
            }

            // Small delay between API calls to avoid rate limiting
            if (i < chunks.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // Step 5: Merge analyses
        sendProgress({ stage: 'merge', progress: 100, message: 'Analyses samenvoegen...' });
        const finalAnalysis = mergeChunkAnalyses(analyses, videoTitle, videoInfo);

        // Optional: Clean up temp files (keep video for now, user can manually delete)
        // cleanupVideoFiles(videoId);

        sendProgress({ stage: 'complete', progress: 100, message: 'Analyse voltooid!' });

        // Clean up running analysis tracker
        runningVideoAnalyses.delete(videoId);

        // Build segments data for timeline
        const segments = analyses.map((a, idx) => ({
            index: idx + 1,
            startTime: a.chunkInfo.startTime,
            endTime: a.chunkInfo.startTime + a.chunkInfo.duration,
            startFormatted: a.chunkInfo.startTimeFormatted,
            endFormatted: a.chunkInfo.endTimeFormatted,
            content: a.content
        }));

        return {
            success: true,
            analysis: finalAnalysis,
            videoId,
            title: videoTitle,
            videoInfo,
            chunksAnalyzed: analyses.length,
            segments: segments, // Timeline data with timestamps
            model: store.get('geminiModel') || 'gemini-2.5-flash',
            analysisType
        };

    } catch (error) {
        console.error('Full video analysis error:', error);

        // Clean up on error too
        const videoId = extractYouTubeId(url);
        if (videoId) {
            runningVideoAnalyses.delete(videoId);
        }

        return { success: false, error: error.message };
    }
});

// Get video info without analysis
ipcMain.handle('get-video-info', async (event, { url }) => {
    try {
        const videoId = extractYouTubeId(url);
        if (!videoId) {
            return { success: false, error: 'Ongeldige YouTube URL' };
        }

        // Get title
        let videoTitle = '';
        try {
            const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
            videoTitle = await new Promise((resolve) => {
                https.get(oembedUrl, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            resolve({ title: `Video ${videoId}` });
                        }
                    });
                }).on('error', () => resolve({ title: `Video ${videoId}` }));
            });
        } catch (e) {
            videoTitle = { title: `Video ${videoId}` };
        }

        return {
            success: true,
            videoId,
            ...videoTitle
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Clean up downloaded video files
ipcMain.handle('cleanup-video', async (event, { videoId }) => {
    try {
        cleanupVideoFiles(videoId);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC HANDLERS - Video Management
// ============================================

// Add video to library
ipcMain.handle('add-video', async (event, video) => {
    const videos = store.get('videos') || [];
    video.id = `video-${Date.now()}`;
    video.addedAt = new Date().toISOString();
    videos.push(video);
    store.set('videos', videos);
    return video;
});

// Update video
ipcMain.handle('update-video', async (event, video) => {
    const videos = store.get('videos') || [];
    const index = videos.findIndex(v => v.id === video.id);
    if (index !== -1) {
        videos[index] = { ...videos[index], ...video };
        store.set('videos', videos);
        return true;
    }
    return false;
});

// Delete video
ipcMain.handle('delete-video', async (event, videoId) => {
    const videos = store.get('videos') || [];
    const filtered = videos.filter(v => v.id !== videoId);
    store.set('videos', filtered);
    return true;
});

// Save analysis
ipcMain.handle('save-analysis', async (event, analysis) => {
    const analyses = store.get('analyses') || [];
    analysis.id = `analysis-${Date.now()}`;
    analysis.createdAt = new Date().toISOString();
    analyses.push(analysis);
    store.set('analyses', analyses);
    return analysis;
});

// Get all analyses
ipcMain.handle('get-analyses', async () => {
    return store.get('analyses') || [];
});

// ============================================
// IPC HANDLERS - Gemini Video Analysis
// ============================================

// Set Gemini API Key
ipcMain.handle('set-gemini-api-key', async (event, apiKey) => {
    store.set('geminiApiKey', apiKey);
    const success = initializeGemini(apiKey);
    return { success, message: success ? 'API key opgeslagen' : 'Ongeldige API key' };
});

// Get Gemini settings
ipcMain.handle('get-gemini-settings', async () => {
    return {
        hasApiKey: !!store.get('geminiApiKey'),
        model: store.get('geminiModel')
    };
});

// Set Gemini model
ipcMain.handle('set-gemini-model', async (event, model) => {
    store.set('geminiModel', model);
    return { success: true };
});

// Extract YouTube video ID from URL
function extractYouTubeId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
        /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// Get YouTube transcript
ipcMain.handle('get-youtube-transcript', async (event, url) => {
    try {
        const videoId = extractYouTubeId(url);
        if (!videoId) {
            return { success: false, error: 'Ongeldige YouTube URL' };
        }

        const transcript = await YoutubeTranscript.fetchTranscript(videoId);

        // Format transcript with timestamps
        const formatted = transcript.map(item => ({
            text: item.text,
            start: item.offset / 1000, // Convert to seconds
            duration: item.duration / 1000
        }));

        return { success: true, transcript: formatted, videoId };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Download video for Gemini analysis (YouTube via temporary file)
async function downloadVideo(url) {
    return new Promise((resolve, reject) => {
        // For YouTube, we'll use the video URL directly with Gemini's URL capability
        const videoId = extractYouTubeId(url);
        if (videoId) {
            // Gemini can analyze YouTube videos directly via URL
            resolve({ type: 'youtube', videoId, url: `https://www.youtube.com/watch?v=${videoId}` });
        } else {
            reject(new Error('Alleen YouTube URLs worden momenteel ondersteund'));
        }
    });
}

// Analyze video with Gemini (using transcript-based analysis)
ipcMain.handle('analyze-video-gemini', async (event, { url, analysisType, customPrompt }) => {
    try {
        if (!genAI) {
            return { success: false, error: 'Gemini API key niet geconfigureerd. Ga naar Settings.' };
        }

        const videoId = extractYouTubeId(url);
        if (!videoId) {
            return { success: false, error: 'Ongeldige YouTube URL' };
        }

        console.log(`Analyzing YouTube video: ${videoId}, type: ${analysisType}`);

        const modelName = store.get('geminiModel') || 'gemini-2.5-flash';
        const model = genAI.getGenerativeModel({ model: modelName });

        // Step 1: Get transcript
        let transcript = [];
        let transcriptText = '';
        try {
            transcript = await YoutubeTranscript.fetchTranscript(videoId);
            transcriptText = transcript.map(t => `[${Math.floor(t.offset/1000)}s] ${t.text}`).join('\n');
            console.log(`Transcript fetched: ${transcript.length} segments`);
        } catch (transcriptError) {
            console.log('Transcript not available:', transcriptError.message);
            transcriptText = '[Transcript niet beschikbaar voor deze video]';
        }

        // Step 2: Try to get video title from YouTube oEmbed API
        let videoTitle = '';
        try {
            const https = require('https');
            const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
            videoTitle = await new Promise((resolve, reject) => {
                https.get(oembedUrl, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            resolve(json.title || '');
                        } catch (e) {
                            resolve('');
                        }
                    });
                }).on('error', () => resolve(''));
            });
            console.log(`Video title: ${videoTitle}`);
        } catch (e) {
            console.log('Could not fetch video title');
        }

        // Build the analysis prompt based on type
        let prompt = '';
        const videoContext = videoTitle ? `VIDEO TITEL: ${videoTitle}\n\n` : '';

        if (analysisType === 'code-extraction') {
            prompt = `${videoContext}Analyseer dit YouTube video transcript grondig en extraheer ALLE code die wordt besproken of gedemonstreerd.

TRANSCRIPT:
${transcriptText}

BELANGRIJKE INSTRUCTIES:
1. Identificeer alle code snippets, commando's en configuraties die worden genoemd
2. Reconstrueer de code zo compleet mogelijk op basis van wat wordt gezegd
3. Geef timestamps waar de code wordt besproken
4. Voeg context toe over wat elke code doet

OUTPUT FORMAT:
## Video Samenvatting
[Korte beschrijving van wat de video behandelt]

## Geëxtraheerde Code Blokken

### [Naam/Beschrijving van code blok 1]
**Context:** [Wat doet deze code]
**Timestamp:** [Tijd in video]
\`\`\`[taal]
[code]
\`\`\`

## Gesproken Uitleg & Tips
[Belangrijke punten die de presentator noemt]

## Installatie & Setup
[Hoe de code te gebruiken]`;
        } else if (analysisType === 'tutorial') {
            prompt = `${videoContext}Analyseer dit tutorial video transcript en maak een complete learning guide.

TRANSCRIPT:
${transcriptText}

ANALYSEER:
1. Alle concepten die worden uitgelegd
2. Stap-voor-stap instructies
3. Code voorbeelden met uitleg
4. Tips en best practices

OUTPUT FORMAT:
## Tutorial Overzicht
[Wat leert de kijker]

## Stap-voor-Stap Guide
1. [Stap 1 met details]
2. [Stap 2 met details]
...

## Code Voorbeelden
[Alle code met uitleg]

## Key Takeaways
[Belangrijkste lessen]`;
        } else if (analysisType === 'technical-deepdive') {
            prompt = `${videoContext}Je bent een senior developer die een COMPLETE TECHNISCHE DOCUMENTATIE maakt van deze video tutorial.

TRANSCRIPT:
${transcriptText}

OPDRACHT: Maak een UITGEBREIDE technische analyse zodat iemand dit project VOLLEDIG kan nabouwen.

## 1. PROJECT OVERZICHT
- Wat wordt er gebouwd (in detail)
- Welke technologieën worden gebruikt
- Architectuur overzicht
- Prerequisites en vereisten

## 2. SETUP & INSTALLATIE
Alle commando's en configuratie stappen:
\`\`\`bash
# Elk commando dat genoemd wordt
\`\`\`

## 3. VOLLEDIGE CODE EXTRACTIE
Voor ELKE code die genoemd of getoond wordt:

### [Bestandsnaam.extensie]
**Doel:** [Wat doet dit bestand]
**Timestamp:** [Wanneer in de video]
\`\`\`[taal]
[VOLLEDIGE code - reconstrueer zo compleet mogelijk]
\`\`\`
**Uitleg:** [Regel-voor-regel uitleg van complexe delen]

## 4. API's & INTEGRATIES
- Welke API's worden gebruikt
- Hoe te authenticeren
- Endpoints en parameters
- API keys en configuratie

## 5. ENVIRONMENT VARIABELEN
\`\`\`env
# Alle environment variables die nodig zijn
KEY=waarde_beschrijving
\`\`\`

## 6. STAP-VOOR-STAP IMPLEMENTATIE
Chronologische guide om dit project te bouwen:
1. [Eerste stap met details]
2. [Tweede stap met details]
...

## 7. BELANGRIJKE CONCEPTEN & TIPS
- Best practices die genoemd worden
- Valkuilen om te vermijden
- Optimalisatie tips
- Security overwegingen

## 8. TESTING & DEBUGGING
- Hoe te testen of het werkt
- Veelvoorkomende fouten en oplossingen

## 9. DEPLOYMENT
- Hoe te deployen (indien besproken)
- Hosting opties

## 10. VERVOLGSTAPPEN
- Uitbreidingsmogelijkheden
- Gerelateerde onderwerpen

BELANGRIJK:
- Wees EXTREEM grondig
- Reconstrueer code zo volledig mogelijk, zelfs als niet alles zichtbaar is
- Voeg commentaar toe aan code voor verduidelijking
- Mis GEEN enkel commando of code snippet`;
        } else if (analysisType === 'full') {
            prompt = `${videoContext}Maak een COMPLETE analyse van dit video transcript:

TRANSCRIPT:
${transcriptText}

ANALYSEER:
1. **Content Samenvatting**: Wat wordt er besproken
2. **Code Extractie**: Haal ALLE code/commando's eruit die worden genoemd
3. **Praktische Tips**: Noteer alle tips en best practices
4. **Implementatie**: Hoe kan de kijker dit toepassen

FORMAT:
## Video Overview
[Titel, onderwerp, hoofdpunten]

## Chronologische Analyse
[Per sectie: wat wordt besproken + relevante code]

## Alle Geëxtraheerde Code
[Complete code blokken met context]

## Implementatie Guide
[Hoe de getoonde concepten te implementeren]`;
        } else {
            prompt = customPrompt ?
                `${videoContext}TRANSCRIPT:\n${transcriptText}\n\n${customPrompt}` :
                `${videoContext}Analyseer dit video transcript en geef een gedetailleerde samenvatting.\n\nTRANSCRIPT:\n${transcriptText}`;
        }

        console.log('Sending to Gemini...');
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        console.log('Gemini response received');

        return {
            success: true,
            analysis: text,
            videoId,
            title: videoTitle,
            model: modelName,
            analysisType,
            transcript: transcript.map(t => ({
                text: t.text,
                start: t.offset / 1000,
                duration: t.duration / 1000
            }))
        };

    } catch (error) {
        console.error('Gemini analysis error:', error);
        return { success: false, error: error.message };
    }
});


// Combined analysis: Transcript + Visual
ipcMain.handle('analyze-video-combined', async (event, { url }) => {
    try {
        if (!genAI) {
            return { success: false, error: 'Gemini API key niet geconfigureerd' };
        }

        const videoId = extractYouTubeId(url);
        if (!videoId) {
            return { success: false, error: 'Ongeldige YouTube URL' };
        }

        // Step 1: Get transcript
        let transcript = [];
        try {
            transcript = await YoutubeTranscript.fetchTranscript(videoId);
        } catch (e) {
            console.log('Transcript not available:', e.message);
        }

        const transcriptText = transcript.length > 0
            ? transcript.map(t => `[${Math.floor(t.offset/1000)}s] ${t.text}`).join('\n')
            : 'Geen transcript beschikbaar';

        // Step 2: Gemini visual + transcript analysis
        const modelName = store.get('geminiModel') || 'gemini-2.5-flash';
        const model = genAI.getGenerativeModel({ model: modelName });

        const combinedPrompt = `Je bent een expert video-analist. Analyseer deze YouTube video GRONDIG.

${transcript.length > 0 ? `TRANSCRIPT VAN DE VIDEO:
${transcriptText}

` : ''}ANALYSEER DE VIDEO EN GEEF:

## 1. Video Overzicht
- Titel/onderwerp
- Wat wordt er behandeld
- Doelgroep

## 2. Gesynchroniseerde Analyse
Geef per sectie van de video:
- **Timestamp** (geschat)
- **Visueel**: Wat is te zien op het scherm
- **Gesproken**: Wat wordt gezegd
- **Code**: Als er code te zien is, extraheer deze EXACT

## 3. Alle Code Blokken
Extraheer ELKE code snippet die in de video verschijnt:
\`\`\`[taal]
[code]
\`\`\`
Met uitleg wat het doet.

## 4. Commands & Configuraties
Alle terminal commands, config files, of setup instructies.

## 5. Folder/Project Structuur
Als getoond, geef de complete structuur.

## 6. Dependencies & Installatie
Alle packages, tools, of vereisten.

## 7. Best Practices & Tips
Alle tips die worden genoemd.

## 8. Implementatie Stappenplan
Concrete stappen om zelf te implementeren.

WEES GRONDIG - Mis geen enkele code snippet!`;

        const result = await model.generateContent([
            {
                fileData: {
                    mimeType: 'video/mp4',
                    fileUri: `https://www.youtube.com/watch?v=${videoId}`
                }
            },
            { text: combinedPrompt }
        ]);

        const response = await result.response;

        return {
            success: true,
            analysis: response.text(),
            transcript: transcript.map(t => ({
                time: Math.floor(t.offset / 1000),
                text: t.text
            })),
            videoId,
            model: modelName,
            url: `https://www.youtube.com/watch?v=${videoId}`
        };

    } catch (error) {
        console.error('Combined analysis error:', error);
        return { success: false, error: error.message };
    }
});

// Analyze local video file with Gemini
ipcMain.handle('analyze-local-video', async (event, { filePath, analysisType }) => {
    try {
        if (!genAI) {
            return { success: false, error: 'Gemini API key niet geconfigureerd' };
        }

        if (!fs.existsSync(filePath)) {
            return { success: false, error: 'Bestand niet gevonden' };
        }

        const modelName = store.get('geminiModel') || 'gemini-2.5-flash';
        const model = genAI.getGenerativeModel({ model: modelName });

        // Read video file
        const videoBuffer = fs.readFileSync(filePath);
        const base64Video = videoBuffer.toString('base64');

        // Determine mime type
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.mp4': 'video/mp4',
            '.mov': 'video/quicktime',
            '.avi': 'video/x-msvideo',
            '.mkv': 'video/x-matroska',
            '.webm': 'video/webm'
        };
        const mimeType = mimeTypes[ext] || 'video/mp4';

        let prompt;
        if (analysisType === 'code-extraction') {
            prompt = `Analyseer deze video en extraheer ALLE code die zichtbaar is.
Voor elke code sectie:
1. Identificeer de programmeertaal
2. Geef de volledige code
3. Beschrijf wat de code doet
4. Noteer eventuele gesproken uitleg

FORMAT:
## Code Extractie

### [Bestandsnaam of beschrijving]
\`\`\`[taal]
[code]
\`\`\`
**Uitleg:** [wat de code doet]`;
        } else {
            prompt = `Maak een COMPLETE analyse van deze video:

1. **Visuele Analyse**: Beschrijf wat er te zien is
2. **Audio/Gesproken Content**: Vat samen wat er gezegd wordt
3. **Code Extractie**: Haal alle zichtbare code eruit
4. **Synchronisatie**: Koppel uitleg aan visuals
5. **Key Takeaways**: Belangrijkste punten

FORMAT:
## Video Analyse

### Overzicht
[Beschrijving van de video]

### Inhoud per Sectie
[Chronologische breakdown]

### Geëxtraheerde Code
[Alle code met context]

### Conclusie
[Belangrijkste lessen]`;
        }

        const result = await model.generateContent([
            {
                inlineData: {
                    mimeType: mimeType,
                    data: base64Video
                }
            },
            { text: prompt }
        ]);

        const response = await result.response;
        const text = response.text();

        return {
            success: true,
            analysis: text,
            filePath,
            model: modelName,
            analysisType
        };

    } catch (error) {
        console.error('Local video analysis error:', error);
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC HANDLERS - Backup System
// ============================================

const BACKUP_DIR = path.join(__dirname, 'backups');

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Create backup
ipcMain.handle('create-backup', async (event, { name, description }) => {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupName = name || `backup-${timestamp}`;
        const backupPath = path.join(BACKUP_DIR, backupName);

        if (fs.existsSync(backupPath)) {
            return { success: false, error: 'Backup met deze naam bestaat al' };
        }

        fs.mkdirSync(backupPath, { recursive: true });

        // Copy core files
        const filesToBackup = [
            { src: path.join(__dirname, 'main.js'), dest: 'main.js' },
            { src: path.join(__dirname, 'preload.js'), dest: 'preload.js' },
            { src: path.join(__dirname, 'package.json'), dest: 'package.json' },
            { src: path.join(__dirname, 'renderer', 'index.html'), dest: 'index.html' }
        ];

        for (const file of filesToBackup) {
            if (fs.existsSync(file.src)) {
                fs.copyFileSync(file.src, path.join(backupPath, file.dest));
            }
        }

        // Save app state
        const appState = {
            config: {
                obsidianVaultPath: store.get('obsidianVaultPath'),
                geminiModel: store.get('geminiModel'),
                hasGeminiKey: !!store.get('geminiApiKey')
            },
            videos: store.get('videos') || [],
            analyses: store.get('analyses') || []
        };
        fs.writeFileSync(path.join(backupPath, 'app-state.json'), JSON.stringify(appState, null, 2));

        // Create VERSION.md
        const versionInfo = `# Brain App Backup: ${backupName}

## Info
- **Datum:** ${new Date().toLocaleString('nl-NL')}
- **Beschrijving:** ${description || 'Geen beschrijving'}

## Bestanden
${filesToBackup.map(f => `- ${f.dest}`).join('\n')}
- app-state.json

## App State
- Videos: ${appState.videos.length}
- Analyses: ${appState.analyses.length}
- Gemini geconfigureerd: ${appState.config.hasGeminiKey ? 'Ja' : 'Nee'}
`;
        fs.writeFileSync(path.join(backupPath, 'VERSION.md'), versionInfo);

        return { success: true, path: backupPath, name: backupName };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// List backups
ipcMain.handle('list-backups', async () => {
    try {
        if (!fs.existsSync(BACKUP_DIR)) {
            return { success: true, backups: [] };
        }

        const dirs = fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => {
                const backupPath = path.join(BACKUP_DIR, d.name);
                const versionPath = path.join(backupPath, 'VERSION.md');
                const statePath = path.join(backupPath, 'app-state.json');

                let info = { name: d.name, date: null, description: '' };

                try {
                    const stats = fs.statSync(backupPath);
                    info.date = stats.mtime.toISOString();

                    if (fs.existsSync(statePath)) {
                        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
                        info.videos = state.videos?.length || 0;
                        info.analyses = state.analyses?.length || 0;
                    }

                    if (fs.existsSync(versionPath)) {
                        const content = fs.readFileSync(versionPath, 'utf-8');
                        const descMatch = content.match(/\*\*Beschrijving:\*\* (.+)/);
                        if (descMatch) info.description = descMatch[1];
                    }
                } catch (e) {}

                return info;
            })
            .sort((a, b) => new Date(b.date) - new Date(a.date));

        return { success: true, backups: dirs };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Restore backup
ipcMain.handle('restore-backup', async (event, backupName) => {
    try {
        const backupPath = path.join(BACKUP_DIR, backupName);

        if (!fs.existsSync(backupPath)) {
            return { success: false, error: 'Backup niet gevonden' };
        }

        // Restore files
        const filesToRestore = [
            { src: 'main.js', dest: path.join(__dirname, 'main.js') },
            { src: 'preload.js', dest: path.join(__dirname, 'preload.js') },
            { src: 'package.json', dest: path.join(__dirname, 'package.json') },
            { src: 'index.html', dest: path.join(__dirname, 'renderer', 'index.html') }
        ];

        for (const file of filesToRestore) {
            const srcPath = path.join(backupPath, file.src);
            if (fs.existsSync(srcPath)) {
                fs.copyFileSync(srcPath, file.dest);
            }
        }

        // Restore app state
        const statePath = path.join(backupPath, 'app-state.json');
        if (fs.existsSync(statePath)) {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            if (state.config?.obsidianVaultPath) {
                store.set('obsidianVaultPath', state.config.obsidianVaultPath);
            }
            if (state.videos) {
                store.set('videos', state.videos);
            }
            if (state.analyses) {
                store.set('analyses', state.analyses);
            }
        }

        return { success: true, message: 'Backup hersteld. Herstart de app om wijzigingen te zien.' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Delete backup
ipcMain.handle('delete-backup', async (event, backupName) => {
    try {
        const backupPath = path.join(BACKUP_DIR, backupName);

        if (!fs.existsSync(backupPath)) {
            return { success: false, error: 'Backup niet gevonden' };
        }

        // Prevent deleting v1.0
        if (backupName.startsWith('v1.0')) {
            return { success: false, error: 'v1.0 backup kan niet verwijderd worden (beschermd)' };
        }

        fs.rmSync(backupPath, { recursive: true });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Export to Obsidian
ipcMain.handle('export-to-obsidian-backup', async () => {
    try {
        const vaultPath = store.get('obsidianVaultPath');
        if (!vaultPath) {
            return { success: false, error: 'Obsidian vault niet geconfigureerd' };
        }

        const backupDir = path.join(vaultPath, '_Brain', 'App-Backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().slice(0, 10);
        const exportPath = path.join(backupDir, `brain-app-export-${timestamp}.md`);

        const appState = {
            videos: store.get('videos') || [],
            analyses: store.get('analyses') || []
        };

        const content = `# Brain App Export - ${new Date().toLocaleDateString('nl-NL')}

## App Configuratie
- Obsidian Vault: ${vaultPath}
- Gemini Model: ${store.get('geminiModel') || 'niet ingesteld'}

## Videos (${appState.videos.length})
${appState.videos.map(v => `- ${v.title || v.id}`).join('\n') || 'Geen videos'}

## Analyses (${appState.analyses.length})
${appState.analyses.map(a => `- ${a.id}: ${a.createdAt}`).join('\n') || 'Geen analyses'}

---
*Geëxporteerd door Brain App*
`;

        fs.writeFileSync(exportPath, content);
        return { success: true, path: exportPath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Get app version
ipcMain.handle('get-app-version', async () => {
    return {
        success: true,
        version: '1.7.0',
        date: '24 januari 2026',
        buildDate: '2026-01-24',
        features: ['Video Analysis', 'Claude Code', 'Mijn Brein', 'Backup System', 'Folder Persistence', 'Gemini 2.5 Flash']
    };
});

// ============================================
// IPC HANDLERS - Folder Persistence (via electron-store)
// ============================================

// Get all folders
ipcMain.handle('get-folders', async () => {
    try {
        const folders = store.get('folders') || {};
        console.log('get-folders: returning', Object.keys(folders).length, 'folders');
        return { success: true, folders };
    } catch (error) {
        console.error('get-folders error:', error);
        return { success: false, error: error.message, folders: {} };
    }
});

// Save all folders
ipcMain.handle('save-folders', async (event, folders) => {
    try {
        store.set('folders', folders);
        console.log('save-folders: saved', Object.keys(folders).length, 'folders');
        return { success: true };
    } catch (error) {
        console.error('save-folders error:', error);
        return { success: false, error: error.message };
    }
});

// Get custom videos/content
ipcMain.handle('get-custom-content', async () => {
    try {
        const content = store.get('customContent') || [];
        console.log('get-custom-content: returning', content.length, 'items');
        return { success: true, content };
    } catch (error) {
        console.error('get-custom-content error:', error);
        return { success: false, error: error.message, content: [] };
    }
});

// Save custom videos/content
ipcMain.handle('save-custom-content', async (event, content) => {
    try {
        store.set('customContent', content);
        console.log('save-custom-content: saved', content.length, 'items');
        return { success: true };
    } catch (error) {
        console.error('save-custom-content error:', error);
        return { success: false, error: error.message };
    }
});

// Config path logging happens after store init in initializeApp()
