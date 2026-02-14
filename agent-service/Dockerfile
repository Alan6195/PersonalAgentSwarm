FROM node:22-alpine

RUN apk add --no-cache git bash curl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npx tsc

CMD ["node", "dist/index.js"]
