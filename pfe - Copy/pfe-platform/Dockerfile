FROM node:20-bookworm-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies.
COPY package*.json ./

# Install runtime + build tooling for sqlite3.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && npm install \
    && apt-get purge -y build-essential \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Bundle app source
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Start the application
CMD [ "npm", "start" ]
