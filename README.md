# CodexDepth Video Server

FFmpeg rendering server for the CodexDepth Bible YouTube automation.

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub repo
3. Select this repo
4. Railway auto-detects the Dockerfile and deploys!
5. Copy your Railway URL (e.g. https://codexdepth-server.up.railway.app)
6. Paste it into your n8n workflow

## API

POST /render
{
  "audio_url": "https://...",
  "video_urls": ["https://...", "https://..."],
  "title": "Video title",
  "style": "dark|epic|peaceful|default"
}
