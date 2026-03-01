FROM node:20-alpine

# Install build tools for native modules
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Copy package.json only first (layer cache)
COPY package.json ./

# Install all dependencies
# IMPORTANT: Downgrade express to v4 to avoid path-to-regexp breaking changes in v5
RUN npm install --legacy-peer-deps && \
    npm install --save --legacy-peer-deps \
      express@4.21.2 \
      cors@2.8.5

# Copy all project files
COPY . .

# Build the Vite/React frontend → produces dist/
RUN npm run build

# Expose the port Render uses
EXPOSE 10000

ENV NODE_ENV=production
ENV PORT=10000

# Run the CommonJS server (.cjs bypasses "type":"module" in package.json)
CMD ["node", "server.cjs"]
