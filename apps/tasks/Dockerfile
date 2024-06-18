# Use an official Node runtime as the base image
FROM node:20

# Set the working directory in the container to /app
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install the application dependencies
RUN npm install

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Copy the rest of the application code to the working directory
COPY . .

# Make port 3002 available outside the container
EXPOSE 3002

# Run the application
CMD [ "npm", "start" ]