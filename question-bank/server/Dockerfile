FROM node:24.19.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-fund && npm cache clean --force
COPY src ./src
COPY public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=8787 BANK_DATABASE=/app/data/bank.sqlite BEHIND_HTTPS_PROXY=true
EXPOSE 8787
CMD ["node", "src/main.js"]
