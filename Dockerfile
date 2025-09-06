# เดิม: FROM mcr.microsoft.com/playwright:v1.46.0-jammy
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
