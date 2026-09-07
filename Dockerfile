# Two stages, so the image cannot ship a dist/ that nobody compiled.
#
# The single-stage version did `COPY dist/ dist/`, which shipped whatever
# happened to sit on the machine running `fly deploy`. dist/ is gitignored, so
# that was silently the output of whenever someone last ran `npm run build`.
# On 2026-09-07 that was six-day-old JavaScript: the deploy reported success,
# the machine passed its checks, and the server kept serving the old behavior.
# Nothing failed, which is what made it dangerous. Building here removes the
# possibility rather than relying on remembering.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist dist/
EXPOSE 3001
CMD ["node", "dist/index.js", "--http"]
