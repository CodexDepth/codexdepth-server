const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '100mb' }));

const TMP = '/tmp';
const MINECRAFT_CLIPS = ['https://drive.google.com/uc?export=download&id=1hG0p6GHcwuOwC_wvVc0tCAbiJqm2mZl-'];

app.get('/', (req, res) => res.json({ status: 'CodexDepth Video Server Running' }));

async function downloadFile(url, dest) {
  const writer = fs.createWriteStream(dest);
  const response = await axios({ url, method: 'GET', responseType: 'stream' });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

app.post('/render', async (req, res) => {
  const { audio_url, video_urls, title, style } = req.body;
  if (!audio_url || !video_urls || !video_urls.length) return res.status(400).json({ error: 'Missing params' });
  const jobId = uuidv4();
  const audioPath = path.join(TMP, jobId+'_audio.mp3');
  const outputPath = path.join(TMP, jobId+'_output.mp4');
  const videoListPath = path.join(TMP, jobId+'_list.txt');
  const videoPaths = [];
  try {
    await downloadFile(audio_url, audioPath);
    for (let i = 0; i < video_urls.slice(0,5).length; i++) {
      const vPath = path.join(TMP, jobId+'_clip'+i+'.mp4');
      await downloadFile(video_urls[i], vPath);
      videoPaths.push(vPath);
    }
    const audioDuration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, meta) => { if (err) reject(err); else resolve(meta.format.duration); });
    });
    let listContent = '';
    for (const vp of videoPaths) listContent += "file '"+vp+"'\n";
    fs.writeFileSync(videoListPath, listContent);
    const vf = style === 'dark' ? 'colorchannelmixer=rr=0.8:gg=0.8:bb=0.9' : 'eq=contrast=1.05:saturation=1.1';
    await new Promise((resolve, reject) => {
      ffmpeg().input(videoListPath).inputOptions(['-f concat','-safe 0']).input(audioPath)
        .outputOptions(['-map 0:v:0','-map 1:a:0','-c:v libx264','-c:a aac','-b:a 192k',
          '-vf','scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,'+vf,
          '-t '+audioDuration,'-shortest','-movflags +faststart','-preset fast','-crf 23'])
        .output(outputPath).on('end',resolve).on('error',reject).run();
    });
    const buf = fs.readFileSync(outputPath);
    [audioPath,outputPath,videoListPath,...videoPaths].forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
    res.json({ success:true, job_id:jobId, file_size_mb:(buf.length/1024/1024).toFixed(2), video_base64:buf.toString('base64') });
  } catch(err) {
    [audioPath,outputPath,videoListPath,...videoPaths].forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
    res.status(500).json({ error: err.message });
  }
});

app.post('/render-reddit-video', async (req, res) => {
  const jobId = uuidv4();
  const tmpDir = path.join(TMP, 'reddit_'+jobId);
  fs.mkdirSync(tmpDir, { recursive: true });
  const audioPath = path.join(tmpDir, 'narration.mp3');
  const minecraftPath = path.join(tmpDir, 'minecraft.mp4');
  const outputPath = path.join(tmpDir, 'final.mp4');
  try {
    const { script, audioBase64, title } = req.body;
    console.log('[Reddit '+jobId+'] Starting - '+title);
    if (audioBase64) {
      fs.writeFileSync(audioPath, Buffer.from(audioBase64, 'base64'));
    } else if (script) {
      const clean = script.replace(/"/g,"'").replace(/\n/g,' ').substring(0,500);
      const wavPath = audioPath.replace('.mp3','.wav');
      execSync('espeak -v en+m3 -s 145 "'+clean+'" -w "'+wavPath+'"', { timeout: 60000 });
      execSync('ffmpeg -y -i "'+wavPath+'" -codec:a libmp3lame -qscale:a 2 "'+audioPath+'"', { timeout: 30000 });
      try { fs.unlinkSync(wavPath); } catch(e) {}
    } else {
      return res.status(400).json({ error: 'No script or audioBase64' });
    }
    const audioDuration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, meta) => { if (err) reject(err); else resolve(meta.format.duration); });
    });
    await downloadFile(MINECRAFT_CLIPS[0], minecraftPath);
    await new Promise((resolve, reject) => {
      ffmpeg().input(minecraftPath).inputOptions(['-stream_loop -1']).input(audioPath)
        .outputOptions(['-map 0:v:0','-map 1:a:0','-c:v libx264','-c:a aac','-b:a 192k',
          '-vf','scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080',
          '-t '+audioDuration,'-movflags +faststart','-preset fast','-crf 23'])
        .output(outputPath)
        .on('progress', p => console.log('[Reddit '+jobId+'] '+Math.round(p.percent||0)+'%'))
        .on('end',resolve).on('error',reject).run();
    });
    const buf = fs.readFileSync(outputPath);
    try { fs.rmSync(tmpDir,{recursive:true,force:true}); } catch(e) {}
    res.json({ success:true, job_id:jobId, file_size_mb:(buf.length/1024/1024).toFixed(2), video_base64:buf.toString('base64') });
  } catch(err) {
    console.error('[Reddit '+jobId+'] Error:', err.message);
    try { fs.rmSync(tmpDir,{recursive:true,force:true}); } catch(e) {}
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('CodexDepth Video Server running on port '+PORT));