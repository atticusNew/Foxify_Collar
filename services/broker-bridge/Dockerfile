FROM node:20-alpine

WORKDIR /app

COPY . .

RUN npm ci

HEALTHCHECK --interval=30s --timeout=10s --start-period=25s --retries=3 \
  CMD node -e "require('http').get('http://localhost:18080/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"

EXPOSE 18080

CMD ["npm", "--workspace", "services/broker-bridge", "run", "start"]
