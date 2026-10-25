FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
WORKDIR /app/packages/shared
RUN npm install && npm run build
WORKDIR /app/apps/api
RUN npm install && npx prisma generate && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/package.json ./
COPY --from=build /app/apps/api/prisma ./prisma
COPY --from=build /app/apps/api/node_modules ./node_modules
COPY --from=build /app/packages/shared /packages/shared
EXPOSE 8012
CMD ["sh", "-c", "npx prisma db push && node dist/main.js"]
