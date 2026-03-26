FROM ghcr.io/browserless/chromium:latest
ENV ENABLE_DEBUGGER=true
ENV PREBOOT_CHROME=true
ENV CONNECTION_TIMEOUT=300000
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
