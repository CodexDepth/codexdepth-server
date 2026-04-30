FROM node:18-slim

# Install FFmpeg and espeak for TTS
RUN apt-get update && apt-get install -y ffmpeg espeak && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install

COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]
