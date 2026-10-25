FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
WORKDIR /app/packages/shared
RUN npm install && npm run build
WORKDIR /app/apps/web
RUN npm install && npm run build

FROM nginx:alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
