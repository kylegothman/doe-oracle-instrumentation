# CIOBrain Frontend

This project uses React, TypeScript, Tailwind CSS, and Vite to provide a modern web interface for the CIOBrain project.

## Running the application

There are two main components:
1. The React Frontend
2. The Express API Server (for Google Cloud Search integration)

### Prerequisites

- Node.js 16+ and npm
- Google Cloud CLI configured with access to your project 
- Proper permissions for the Google Cloud Search API

### Setting up the Express API Server

1. Navigate to the project directory
   ```
   cd ciobrain-frontend
   ```

2. Install Express server dependencies
   ```
   npm install --prefix server-api cors express node-fetch
   npm install --prefix server-api --save-dev nodemon
   ```

3. Start the Express server
   ```
   node server.js
   ```
   Or with auto-reload:
   ```
   npx nodemon server.js
   ```

### Running the Frontend

1. In a separate terminal, install frontend dependencies (if not already done)
   ```
   npm install
   ```

2. Start the development server
   ```
   npm run dev
   ```

3. Open your browser at http://localhost:5173 (or whatever port Vite assigns)

## Features

- Modern React with TypeScript for type safety
- Tailwind CSS for styling
- Integration with Google Cloud Search API
- Support for search and answer generation

## API Integration

The frontend communicates with Google Cloud Search through our Express API server, which:

1. Uses `gcloud auth print-access-token` to securely get a Google Cloud access token
2. Proxies search and answer generation requests to the Google Cloud Search API
3. Returns formatted results to the frontend

## Environment Variables

For production, you may want to set these variables:
- `PORT`: Port for the Express server (default: 5000)
