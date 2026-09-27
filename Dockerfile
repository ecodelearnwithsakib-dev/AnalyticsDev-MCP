# Analytics Dev MCP — all servers in one image.
#   docker build -t analyticsdev-mcp .
#   docker run -i --rm -v ~/.analyticsdev-mcp:/config analyticsdev-mcp ga4          # one server over stdio
#   docker run --rm -p 127.0.0.1:8787:8787 -v ~/.analyticsdev-mcp:/config \
#     analyticsdev-mcp serve ga4,meta --host 0.0.0.0 --oauth                          # HTTP gateway
# /config holds .env, .env.<profile>, .state/ and reports/. Browser sign-ins (npm run auth:*) are done
# on your computer first; copy the resulting .env into /config.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx tsc && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production MCP_HOME=/config
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json .env.example slack-app-manifest.json ./
RUN mkdir -p /config && chown node:node /config
USER node
VOLUME ["/config"]
EXPOSE 8787
ENTRYPOINT ["node", "dist/shared/cli.js"]
CMD ["list"]
