FROM node:20-alpine

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install ALL deps — then force Express 4 (Express 5 breaks wildcard routes)
RUN npm install --legacy-peer-deps && \
    npm install --save express@4.21.2 cors@2.8.5 --legacy-peer-deps

# Copy source
COPY . .

# Build React frontend
RUN npm run build

# Expose port
EXPOSE 10000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:10000/health || exit 1

# Run CommonJS server (bypasses "type":"module" in package.json)
CMD ["node", "server.cjs"]
