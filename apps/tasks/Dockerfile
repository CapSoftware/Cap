# Use an official Node runtime as the base image
FROM node:20

# Declaring env
ENV NODE_ENV=production

# Set the working directory in the container to /app
WORKDIR /app

# Copy all the files from the project’s root to the working directory in the container
COPY . .

# Install all the dependencies
RUN npm install

# Build the app
RUN npm run build

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Start the app
CMD ["npm", "start"]