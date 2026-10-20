# Deploys the WhatsApp bot in wa-bot/ (Railway builds from the repo root).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Jerusalem DATA_DIR=/app/data
COPY wa-bot/package.json wa-bot/package-lock.json ./
RUN npm ci --omit=dev
COPY wa-bot/src ./src
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
