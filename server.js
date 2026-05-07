const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '50mb' }));

const TMP = '/tmp';
const MINECRAFT_URL = 'https://archive.org/download/MinecraftPEMapsSUPERFASTPARKOURSonicTheHedgehogParkourLow480x360Mp4/PARKOUR!%20(minecraft%20style)%5BLow%2C480x360%2C%20Mp4%5D.mp4';
const videoCache = {};

app.get('/', (req, res) => res.json({ status: 'CodexDepth Video Server Running' }));

// Serve rendered video by ID
app.get('/video/:id', (req, res) => {
  const filePath = videoCache[req.params.id];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename=video.mp4');
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('end', () => { try { fs.unlinkSync(filePath); delete videoCache[req.params.id]; } catch(e) {} });
});

async function downloadFile(url, dest) {
  const writer = fs.createWriteStream(dest);
  const response = await axios({ url, method: 'GET', responseType: 'stream', maxRedirects: 10, headers: { 'User-Agent': 'Mozilla/5.0' } });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

app.post('/render', (req, res) => res.status(200).json({ success: true, video_base64: '' }));

app.post('/render-reddit-video', async (req, res) => {
  const jobId = uuidv4();
  const tmpDir = path.join(TMP, 'reddit_' + jobId);
  fs.mkdirSync(tmpDir, { recursive: true });
  const audioPath = path.join(tmpDir, 'narration.mp3');
  const minecraftPath = path.join(tmpDir, 'minecraft.mp4');
  const outputPath = path.join(TMP, 'final_' + jobId + '.mp4');
  try {
    const { script, audioBase64, title } = req.body;
    console.log('[Reddit ' + jobId + '] Starting - ' + title);

    if (audioBase64) {
      fs.writeFileSync(audioPath, Buffer.from(audioBase64, 'base64'));
    } else if (script) {
      const scriptFile = path.join(tmpDir, 'script.txt');
      fs.writeFileSync(scriptFile, script.replace(/"/g, "'"), 'utf8');
      const wavPath = audioPath.replace('.mp3', '.wav');
      execSync('espeak -v en+m3 -s 145 -f "' + scriptFile + '" -w "' + wavPath + '"', { timeout: 300000 });
      execSync('ffmpeg -y -i "' + wavPath + '" -codec:a libmp3lame -qscale:a 2 "' + audioPath + '"', { timeout: 60000 });
      try { fs.unlinkSync(wavPath); } catch(e) {}
      console.log('[Reddit ' + jobId + '] TTS done');
    } else {
      return res.status(400).json({ error: 'No script or audioBase64' });
    }

    const audioDuration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, meta) => { if (err) reject(err); else resolve(meta.format.duration); });
    });
    console.log('[Reddit ' + jobId + '] Audio: ' + audioDuration + 's');

    await downloadFile(MINECRAFT_URL, minecraftPath);
    if (fs.statSync(minecraftPath).size < 100000) throw new Error('Minecraft download failed');

    console.log('[Reddit ' + jobId + '] Rendering...');
    execSync(
      'ffmpeg -y -stream_loop -1 -i "' + minecraftPath + '" -i "' + audioPath + '" ' +
      '-map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 96k -t ' + audioDuration + ' ' +
      '"' + outputPath + '"',
      { timeout: 600000 }
    );

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}

    videoCache[jobId] = outputPath;
    const baseUrl = 'https://codexdepth-server-production.up.railway.app';
    const videoUrl = baseUrl + '/video/' + jobId;
    console.log('[Reddit ' + jobId + '] Done! URL: ' + videoUrl);
    res.json({ success: true, job_id: jobId, video_url: videoUrl });

  } catch(err) {
    console.error('[Reddit ' + jobId + '] Error:', err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('CodexDepth Video Server running on port ' + PORT));
