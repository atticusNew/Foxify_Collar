FROM node:20-alpine

WORKDIR /app

COPY . .

RUN npm ci

RUN mkdir -p /app/logs

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"

EXPOSE 8000

CMD ["npm", "--workspace", "services/api", "exec", "tsx", "src/server.ts"]
