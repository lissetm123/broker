# Use official lightweight Node.js image
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy dependency files first (leverage Docker caching)
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application source code (server.js and public folder)
COPY . .

# Cloud Run defaults to exposing port 8080.
# The server will read this from process.env.PORT.
EXPOSE 8080

# Start the broker
CMD [ "npm", "start" ]
