const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '50mb' }));

const TMP = '/tmp';

// Minecraft parkour footage hosted on Google Drive
const MINECRAFT_CLIPS = [
  'https://drive.google.com/uc?export=download&id=1hG0p6GHcwuOwC_wvVc0tCAbiJqm2mZl-',
];

// Health check
app.get('/', (req, res) => res.json({ status: 'CodexDepth Video Server Running' }));

// Download a file from URL to local path
async function downloadFile(url, dest) {
  const writer = fs.createWriteStream(dest);
  const response = await axios({ url, method: 'GET', responseType: 'stream' });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Main render endpoint (existing - Bible channel)
app.post('/render', async (req, res) => {
  const { audio_url, video_urls, title, style } = req.body;

  if (!audio_url || !video_urls || !video_urls.length) {
    return res.status(400).json({ error: 'Missing audio_url or video_urls' });
  }

  const jobId = uuidv4();
  const audioPath = path.join(TMP, `${jobId}_audio.mp3`);
  const outputPath = path.join(TMP, `${jobId}_output.mp4`);
  const videoListPath = path.join(TMP, `${jobId}_list.txt`);
  const videoPaths = [];

  try {
    console.log(`[${jobId}] Starting render job: ${title}`);

    console.log(`[${jobId}] Downloading audio...`);
    await downloadFile(audio_url, audioPath);

    const clipsToUse = video_urls.slice(0, 5);
    for (let i = 0; i < clipsToUse.length; i++) {
      const vPath = path.join(TMP, `${jobId}_clip${i}.mp4`);
      console.log(`[${jobId}] Downloading clip ${i + 1}...`);
      await downloadFile(clipsToUse[i], vPath);
      videoPaths.push(vPath);
    }

    const audioDuration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, meta) => {
        if (err) reject(err);
        else resolve(meta.format.duration);
      });
    });
    console.log(`[${jobId}] Audio duration: ${audioDuration}s`);

    let listContent = '';
    for (const vp of videoPaths) {
      listContent += `file '${vp}'\n`;
    }
    fs.writeFileSync(videoListPath, listContent);

    const styles = {
      'dark': 'colorchannelmixer=rr=0.8:gg=0.8:bb=0.9,vignette=PI/4',
      'epic': 'eq=contrast=1.1:saturation=1.2:brightness=0.05',
      'peaceful': 'eq=saturation=0.9:brightness=0.02,gblur=sigma=0.5',
      'default': 'eq=contrast=1.05:saturation=1.1'
    };
    const videoFilter = styles[style] || styles['default'];

    console.log(`[${jobId}] Rendering video...`);
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoListPath)
        .inputOptions(['-f concat', '-safe 0'])
        .input(audioPath)
        .outputOptions([
          '-map 0:v:0',
          '-map 1:a:0',
          '-c:v libx264',
          '-c:a aac',
          '-b:a 192k',
          '-vf', `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,${videoFilter}`,
          `-t ${audioDuration}`,
          '-shortest',
          '-movflags +faststart',
          '-preset fast',
          '-crf 23'
        ])
        .output(outputPath)
        .on('start', () => console.log(`[${jobId}] FFmpeg started`))
        .on('progress', p => console.log(`[${jobId}] Progress: ${Math.round(p.percent || 0)}%`))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log(`[${jobId}] Render complete!`);
    const videoBuffer = fs.readFileSync(outputPath);
    const base64Video = videoBuffer.toString('base64');
    const fileSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(2);

    [audioPath, outputPath, videoListPath, ...videoPaths].forEach(f => {
      try { fs.unlinkSync(f); } catch(e) {}
    });

    res.json({
      success: true,
      job_id: jobId,
      file_size_mb: fileSizeMB,
      video_base64: base64Video
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err);
    [audioPath, outputPath, videoListPath, ...videoPaths].forEach(f => {
      try { fs.unlinkSync(f); } catch(e) {}
    });
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Reddit Story Videos with Minecraft background
// ─────────────────────────────────────────────────────────────

// ElevenLabs TTS — uses "Rachel" voice (calm, clear, works great for narration)
async function generateTTS(script, outputPath) {
  const ELEVEN_API_KEY = 'sk_3e3cd3e8461401ce438b66642f398e9b2e9990b5ef4d28cb';
  const VOICE_ID = 'wBXNqKUATyqu0RtYt25i'; // Rachel — ElevenLabs default voice

  const response = await axios({
    method: 'POST',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    headers: {
      'xi-api-key': ELEVEN_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    data: {
      text: script,
      model_id: 'eleven_monolingual_v1',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    },
    responseType: 'arraybuffer'
  });

  fs.writeFileSync(outputPath, Buffer.from(response.data));
}

function generateSRT(script, audioDuration) {
  const words = script.split(' ');
  const chunkSize = 8;
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(' '));
  }
  const timePerChunk = audioDuration / chunks.length;
  const fmt = (s) => {
    const h = Math.floor(s / 3600).toString().padStart(2, '0');
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    const ms = Math.floor((s % 1) * 1000).toString().padStart(3, '0');
    return `${h}:${m}:${sec},${ms}`;
  };
  let srt = '';
  chunks.forEach((chunk, i) => {
    srt += `${i + 1}\n${fmt(i * timePerChunk)} --> ${fmt((i + 1) * timePerChunk)}\n${chunk}\n\n`;
  });
  return srt;
}

app.post('/render-reddit-video', async (req, res) => {
  const jobId = uuidv4();
  const tmpDir = path.join(TMP, `reddit_${jobId}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const audioPath     = path.join(tmpDir, 'narration.mp3');
  const minecraftPath = path.join(tmpDir, 'minecraft.mp4');
  const srtPath       = path.join(tmpDir, 'subtitles.srt');
  const outputPath    = path.join(tmpDir, 'final.mp4');

  try {
    const { script, title } = req.body;
    if (!script) return res.status(400).json({ error: 'No script provided' });

    console.log(`[Reddit ${jobId}] Starting — "${title}"`);

    console.log(`[Reddit ${jobId}] API Key exists: ${!!'sk_3e3cd3e8461401ce438b66642f398e9b2e9990b5ef4d28cb'}, length: ${('sk_3e3cd3e8461401ce438b66642f398e9b2e9990b5ef4d28cb' || '').length}`);
    await generateTTS(script, audioPath);

    const audioDuration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, meta) => {
        if (err) reject(err);
        else resolve(meta.format.duration);
      });
    });
    console.log(`[Reddit ${jobId}] Audio duration: ${audioDuration}s`);

    const randomUrl = MINECRAFT_CLIPS[Math.floor(Math.random() * MINECRAFT_CLIPS.length)];
    console.log(`[Reddit ${jobId}] Downloading Minecraft clip...`);
    await downloadFile(randomUrl, minecraftPath);

    const srtContent = generateSRT(script, audioDuration);
    fs.writeFileSync(srtPath, srtContent);

    console.log(`[Reddit ${jobId}] Rendering video...`);
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(minecraftPath)
        .inputOptions(['-stream_loop -1'])
        .input(audioPath)
        .outputOptions([
          '-map 0:v:0',
          '-map 1:a:0',
          '-c:v libx264',
          '-c:a aac',
          '-b:a 192k',
          '-vf', `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,subtitles='${srtPath}':force_style='FontName=Arial,FontSize=20,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Alignment=2,MarginV=50'`,
          `-t ${audioDuration}`,
          '-movflags +faststart',
          '-preset fast',
          '-crf 23'
        ])
        .output(outputPath)
        .on('start', () => console.log(`[Reddit ${jobId}] FFmpeg started`))
        .on('progress', p => console.log(`[Reddit ${jobId}] Progress: ${Math.round(p.percent || 0)}%`))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log(`[Reddit ${jobId}] Render complete!`);
    const videoBuffer = fs.readFileSync(outputPath);
    const base64Video = videoBuffer.toString('base64');
    const fileSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(2);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

    res.json({
      success: true,
      job_id: jobId,
      file_size_mb: fileSizeMB,
      video_base64: base64Video
    });

  } catch (err) {
    console.error(`[Reddit ${jobId}] Error:`, err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CodexDepth Video Server running on port ${PORT}`));
