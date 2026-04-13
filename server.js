const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '50mb' }));

const TMP = '/tmp';

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

// Main render endpoint
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

    // Download audio
    console.log(`[${jobId}] Downloading audio...`);
    await downloadFile(audio_url, audioPath);

    // Download video clips (max 5)
    const clipsToUse = video_urls.slice(0, 5);
    for (let i = 0; i < clipsToUse.length; i++) {
      const vPath = path.join(TMP, `${jobId}_clip${i}.mp4`);
      console.log(`[${jobId}] Downloading clip ${i + 1}...`);
      await downloadFile(clipsToUse[i], vPath);
      videoPaths.push(vPath);
    }

    // Get audio duration
    const audioDuration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, meta) => {
        if (err) reject(err);
        else resolve(meta.format.duration);
      });
    });
    console.log(`[${jobId}] Audio duration: ${audioDuration}s`);

    // Build concat list - loop clips to fill audio duration
    const clipDuration = audioDuration / clipsToUse.length;
    let listContent = '';
    for (const vp of videoPaths) {
      listContent += `file '${vp}'\n`;
    }
    fs.writeFileSync(videoListPath, listContent);

    // Style settings
    const styles = {
      'dark': 'colorchannelmixer=rr=0.8:gg=0.8:bb=0.9,vignette=PI/4',
      'epic': 'eq=contrast=1.1:saturation=1.2:brightness=0.05',
      'peaceful': 'eq=saturation=0.9:brightness=0.02,gblur=sigma=0.5',
      'default': 'eq=contrast=1.05:saturation=1.1'
    };
    const videoFilter = styles[style] || styles['default'];

    // Render with FFmpeg
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
        .on('start', cmd => console.log(`[${jobId}] FFmpeg started`))
        .on('progress', p => console.log(`[${jobId}] Progress: ${Math.round(p.percent || 0)}%`))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Read output and return as base64
    console.log(`[${jobId}] Render complete! Reading output...`);
    const videoBuffer = fs.readFileSync(outputPath);
    const base64Video = videoBuffer.toString('base64');
    const fileSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(2);

    console.log(`[${jobId}] Done! File size: ${fileSizeMB}MB`);

    // Cleanup
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
    // Cleanup on error
    [audioPath, outputPath, videoListPath, ...videoPaths].forEach(f => {
      try { fs.unlinkSync(f); } catch(e) {}
    });
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CodexDepth Video Server running on port ${PORT}`));
