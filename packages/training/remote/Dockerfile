FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs infer.mjs manifest.json weights.json ./
COPY --chown=node:node runtime/ ./runtime/
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
