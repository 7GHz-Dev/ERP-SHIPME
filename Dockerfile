FROM node:26-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 8080
CMD ["node", "src/server.js"]
