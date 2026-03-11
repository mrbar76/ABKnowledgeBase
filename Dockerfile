FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Generate PNG icons from SVG (install sharp temporarily)
COPY scripts/generate-icons.js scripts/
COPY public/icons/icon.svg public/icons/
RUN npm install sharp --no-save 2>/dev/null && node scripts/generate-icons.js || echo "Skipping icon generation"

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
