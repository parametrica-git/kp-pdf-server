# Официальный образ Puppeteer — внутри уже есть Chromium и все системные библиотеки.
FROM ghcr.io/puppeteer/puppeteer:23.6.0

# не докачивать Chromium (он уже в образе) — используем встроенный
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

WORKDIR /home/pptruser/app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

# Render/контейнер пробрасывает порт через переменную $PORT (сервер её читает)
CMD ["node", "server.js"]
