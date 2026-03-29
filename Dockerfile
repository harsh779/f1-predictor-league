FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY scripts ./scripts
COPY server.js ./

EXPOSE 3000

CMD ["npm", "start"]
