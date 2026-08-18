FROM node:20-alpine
WORKDIR /app

# Dependencias primero (mejor caché) e instalación reproducible.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# El proceso no corre como root: si alguien lograra ejecutar código dentro del
# contenedor, no tendría permisos sobre el sistema de archivos de la imagen.
# La imagen de node ya trae el usuario `node` (uid 1000).
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "src/server.js"]
