const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { buildPublicBaseUrl } = require('./protocol');

const app = express();
app.use(cors());
app.use(express.json());

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
});


// Simple in-memory cache — YouTube signed URLs expire in ~6 hours
const cache = new Map();
const refreshes = new Map();
const resolutions = new Map();
const fileDownloads = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const YOUTUBE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const AUDIO_CACHE_DIR = path.join(__dirname, '.audio-cache');
const PYTHON_BIN = process.platform === 'win32' ? 'python' : 'python3';
const UPSTREAM_TIMEOUT_MS = 45000;

function fetchWithTimeout(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getCached(videoId) {
  const entry = cache.get(videoId);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
    console.log(`[cache hit] ${videoId}`);
    return entry;
  }
  return null;
}

function setCached(videoId, url) {
  cache.set(videoId, { url, ts: Date.now() });
}

async function validateAudioUrl(url) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return false;
  }

  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'User-Agent': YOUTUBE_USER_AGENT,
        'Referer': 'https://www.youtube.com/',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        Range: 'bytes=0-32767',
      },
    }, 20000);

    const contentType = (response.headers && response.headers.get && response.headers.get('content-type')) || '';
    const accepted = /audio\//i.test(contentType) || /video\/mp4/i.test(contentType) || /audio/i.test(contentType);
    const valid = response.ok && accepted;
    response.body?.destroy();
    return valid;
  } catch (error) {
    return false;
  }
}

function pickBestSupportedAudioFormat(formats) {
  if (!Array.isArray(formats) || formats.length === 0) return null;

  const preferred = formats.find(f => f && f.itag === 140)
    || formats.find(f => f && f.mimeType && /audio\/mp4|audio\/mpeg/i.test(f.mimeType))
    || formats.find(f => f && !f.hasVideo && f.hasAudio && f.url)
    || formats.find(f => f && f.url && !f.hasVideo && f.hasAudio);

  return preferred || null;
}

const play = require('play-dl');
const ytdl = require('@distube/ytdl-core');

const extractWithYtDlp = async (videoId) => {
  const clients = ['android_vr', 'android'];
  let lastError = new Error('No URL returned from yt-dlp');

  for (const client of clients) {
    try {
      const url = await new Promise((resolve, reject) => {
        const cmd = `${PYTHON_BIN} -m yt_dlp --no-playlist --extractor-args "youtube:player_client=${client}" --user-agent "${YOUTUBE_USER_AGENT}" --referer "https://www.youtube.com/" -f "140/251/250/bestaudio/best" --get-url "https://www.youtube.com/watch?v=${videoId}"`;
        exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
          if (error) return reject(new Error(stderr.trim() || error.message));
          const mediaUrl = stdout.trim().split(/\r?\n/).find(line => /^https?:\/\//i.test(line));
          if (!mediaUrl) return reject(new Error('No URL returned from yt-dlp'));
          resolve(mediaUrl);
        });
      });
      console.log(`[yt-dlp] ${client} extraction succeeded for ${videoId}`);
      return url;
    } catch (error) {
      lastError = error;
      console.warn(`[yt-dlp] ${client} extraction failed for ${videoId}: ${error.message}`);
    }
  }

  throw lastError;
};

// Helper to retrieve the raw URL
const resolveAudioUrl = async (videoId, forceRefresh = false, retryWithSearch = false) => {
  const cachedEntry = forceRefresh ? null : getCached(videoId);
  if (cachedEntry) {
    return cachedEntry.url;
  }

  try {
    const audioUrl = await extractWithYtDlp(videoId);
    setCached(videoId, audioUrl);
    return audioUrl;
  } catch (ytDlpErr) {
    console.warn(`[getAudioUrl] yt-dlp primary extraction failed for ${videoId}: ${ytDlpErr.message}`);
  }

  throw new Error(`No playable YouTube media URL available for ${videoId}`);
};

const getAudioUrl = (videoId, forceRefresh = false, retryWithSearch = false) => {
  if (!forceRefresh) {
    const pendingResolution = resolutions.get(videoId);
    if (pendingResolution) return pendingResolution;
    const resolution = resolveAudioUrl(videoId, false, retryWithSearch).finally(() => {
      resolutions.delete(videoId);
    });
    resolutions.set(videoId, resolution);
    return resolution;
  }

  const pendingRefresh = refreshes.get(videoId);
  if (pendingRefresh) return pendingRefresh;

  cache.delete(videoId);
  const refresh = resolveAudioUrl(videoId, true, retryWithSearch).finally(() => {
    refreshes.delete(videoId);
  });
  refreshes.set(videoId, refresh);
  return refresh;
};

async function ensureCachedAudioFile(videoId) {
  const targetPath = path.join(AUDIO_CACHE_DIR, `${videoId}.m4a`);
  try {
    const info = await fs.promises.stat(targetPath);
    if (info.size >= 150000) return targetPath;
  } catch (_) {
    // The file has not been downloaded yet.
  }

  const pendingDownload = fileDownloads.get(videoId);
  if (pendingDownload) return pendingDownload;

  const download = (async () => {
    await fs.promises.mkdir(AUDIO_CACHE_DIR, { recursive: true });
    const tempPath = `${targetPath}.part`;
    await fs.promises.rm(tempPath, { force: true });

    const rawUrl = await getAudioUrl(videoId, true);
    const response = await fetchWithTimeout(rawUrl, {
      headers: {
        'User-Agent': YOUTUBE_USER_AGENT,
        'Referer': 'https://www.youtube.com/',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
      },
      redirect: 'follow',
    });
    if (!response.ok || !response.body) {
      response.body?.destroy();
      throw new Error(`Audio cache request failed with HTTP ${response.status}`);
    }

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(tempPath);
      response.body.pipe(output);
      response.body.on('error', reject);
      output.on('error', reject);
      output.on('finish', resolve);
    });

    const info = await fs.promises.stat(tempPath);
    if (info.size < 150000) throw new Error(`yt-dlp produced an invalid audio file (${info.size} bytes)`);
    await fs.promises.rename(tempPath, targetPath);
    return targetPath;
  })().finally(() => {
    fileDownloads.delete(videoId);
  });

  fileDownloads.set(videoId, download);
  return download;
}

async function sendCachedAudioFile(videoId, req, res) {
  const filePath = await ensureCachedAudioFile(videoId);
  const info = await fs.promises.stat(filePath);
  const range = req.headers.range;
  let start = 0;
  let end = info.size - 1;

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      if (match[1]) start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
      if (!match[1] && match[2]) start = Math.max(info.size - Number(match[2]), 0);
      end = Math.min(end, info.size - 1);
    }
  }

  if (start > end || start >= info.size) {
    res.status(416).set('Content-Range', `bytes */${info.size}`).end();
    return;
  }

  const partial = Boolean(range);
  res.status(partial ? 206 : 200);
  res.set({
    'Content-Type': 'audio/mp4',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

// GET /api/audio/:videoId — Returns the custom stream proxy URL instead of raw Google URL
app.get('/api/audio/:videoId', (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  const baseUrl = buildPublicBaseUrl(req);
  const audioUrl = `${baseUrl}/api/stream/${videoId}`;
  res.json({ audioUrl });
});

// GET /api/audio/raw/:videoId — Returns the DIRECT RAW Google URL for Expo File System downloads
app.get('/api/audio/raw/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }
  try {
    const rawUrl = await getAudioUrl(videoId);
    res.json({ audioUrl: rawUrl });
  } catch (error) {
    console.error('Error fetching raw URL', error);
    res.status(500).json({ error: error.message });
  }
});

const fetch = require('node-fetch');

// GET /api/stream/:videoId — Seamlessly acts as a Reverse Proxy with perfect HTTP Byte Range support
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).send('Invalid video ID');
  }

  try {
    const forceRefresh = req.query.nocache === '1';
    let rawUrl = await getAudioUrl(videoId, forceRefresh);
    const headers = {
      'User-Agent': YOUTUBE_USER_AGENT,
      'Referer': 'https://www.youtube.com/',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
    };
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }
    
    let response = await fetchWithTimeout(rawUrl, { headers, redirect: 'follow' });
    
    // Auto-refresh the URL if YouTube returns 403 Forbidden or 410 Gone
    if (!response.ok && (response.status === 403 || response.status === 410 || response.status === 400)) {
       console.warn(`[Stream Error] ${response.status} for ${videoId}. Expired URL? Refreshing cache...`);
       cache.delete(videoId); // Invalidate cached URL
       rawUrl = await getAudioUrl(videoId, true); // Force fetch new URL
       response.body?.destroy();
      response = await fetchWithTimeout(rawUrl, { headers, redirect: 'follow' });
    }

     if (!response.ok) {
      response.body?.destroy();
      console.warn(`[Stream Fallback] Using local audio cache for ${videoId}`);
      return sendCachedAudioFile(videoId, req, res);
     }

    res.status(response.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(header => {
      if (response.headers.has(header)) res.setHeader(header, response.headers.get(header));
    });
    response.body.pipe(res);
    req.on('close', () => response.body.destroy());

  } catch (error) {
    console.error(`[Stream Error]`, error);
    if (!res.headersSent) res.status(500).send('Streaming error');
  }
});

// GET /api/youtube/* — Secure Reverse Proxy for YouTube Data API to bypass Web CORS and Referrer Blocks
app.get('/api/youtube/*', async (req, res) => {
  const path = req.params[0];
  const queryString = new URLSearchParams(req.query).toString();
  const url = `https://www.googleapis.com/youtube/v3/${path}?${queryString}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('YouTube Proxy Error:', error);
    res.status(500).json({ error: error.message });
  }
});

const ytSearch = require('yt-search');
const searchCache = new Map();

app.get('/api/search', async (req, res) => {
  console.log(`[API] GET /api/search?q=${req.query.q}`);
  try {
    const query = req.query.q;
    
    if (searchCache.has(query)) {
      const cachedResult = searchCache.get(query);
      if (Date.now() - cachedResult.timestamp < 1000 * 60 * 60 * 24) { // 24 hours
        return res.json(cachedResult.data);
      }
    }

    const r = await ytSearch(query);
    searchCache.set(query, { data: r, timestamp: Date.now() });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/playlist/:playlistId', async (req, res) => {
  try {
    const playlistId = req.params.playlistId;
    const albumTitle = req.query.albumTitle || '';
    const albumArtist = req.query.albumArtist || '';
    
    console.log(`[Playlist] Fetching playlist: ${playlistId}`);
    
    let list = null;
    try {
      const util = require('util');
      const execPromise = util.promisify(require('child_process').exec);
      // Run yt-dlp to get the exact original playlist videos fast
      const { stdout } = await execPromise(`${PYTHON_BIN} -m yt_dlp --dump-json --flat-playlist "https://www.youtube.com/playlist?list=${playlistId}"`);
      const lines = stdout.trim().split('\n');
      
      list = {
        title: albumTitle || 'Playlist',
        videos: lines.map(line => {
           try {
             const v = JSON.parse(line);
             return {
               videoId: v.id,
               title: v.title || v.fulltitle || 'Unknown Title',
               author: { name: v.channel || v.uploader || '', url: v.uploader_url || '' },
               duration: { seconds: v.duration || 0 },
               thumbnail: (v.thumbnails && v.thumbnails.length > 0) ? v.thumbnails[v.thumbnails.length - 1].url : ''
             };
           } catch(e) { return null; }
        }).filter(v => v && v.videoId)
      };
      console.log(`[Playlist] yt-dlp returned ${list.videos.length} original videos`);
    } catch (parseErr) {
      console.warn(`[Playlist] yt-dlp failed:`, parseErr.message);
      // Robust fallback to yt-search library (built-in playlist support)
      try {
        const r = await ytSearch({ listId: playlistId });
        if (r && r.videos && r.videos.length > 0) {
          list = {
            title: r.title || albumTitle,
            videos: r.videos.map(v => ({
              videoId: v.videoId,
              title: v.title,
              author: { name: v.author?.name || '', url: v.author?.url || '' },
              duration: { seconds: v.duration?.seconds || 0 },
              thumbnail: v.thumbnail || ''
            }))
          };
          console.log(`[Playlist] yt-search fallback returned ${list.videos.length} videos`);
        }
      } catch (ytsErr) {
        console.warn(`[Playlist] yt-search fallback failed:`, ytsErr.message);
      }
    }

    // Fallback if playlist fetch failed or returned no videos
    if (!list || !list.videos || list.videos.length === 0) {
      console.warn(`[Playlist] Empty playlist after primary and secondary methods. Returning empty array.`);
      list = {
        title: albumTitle || 'Playlist',
        videos: [],
      };
    }
    
    res.json(list);
  } catch (e) {
    console.error(`[Playlist Error] ${req.params.playlistId}:`, e.message);
    res.status(500).json({ error: e.message, videos: [] });
  }
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 5000;
// Listen on all interfaces so the phone can reach it over LAN
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nSoundStream backend running on http://0.0.0.0:${PORT}`);
  console.log(`From your phone use: http://10.0.0.207:${PORT}`);
  console.log(`Health check: http://10.0.0.207:${PORT}/health\n`);
});
