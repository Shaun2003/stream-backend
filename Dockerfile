FROM node:20-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
  && python3 -m pip install --no-cache-dir --break-system-packages yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js protocol.js ./

ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
