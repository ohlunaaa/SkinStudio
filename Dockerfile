FROM node:24-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
