FROM node:22-alpine

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json package-lock.json* ./
RUN npm install

# Copy source
COPY . .

# Expose dev server port
EXPOSE 3000

# Default: dev mode with hot reload
CMD ["npm", "run", "dev"]
