# ValetNYC Backend API

Backend API for ValetNYC application built with Node.js, Express, and MongoDB.

## Prerequisites

- Node.js (v14 or higher)
- MongoDB
- npm or yarn

## Installation

```bash
npm install
```

## Environment Setup

Create your environment files:
- `.env` - Production environment variables
- `.env.development` - Development environment variables

## Running the Application

### Development Mode (with nodemon)

```bash
# Run with default environment
npm run dev

# Run with .env file
npm run dev:prod

# Run with .env.development file
npm run dev:dev
```

### Production Mode

```bash
# Run with default environment
npm start

# Run with .env file
npm run start:prod

# Run with .env.development file
npm run start:dev
```

## API Documentation

Swagger documentation is available at `/api-docs` when the server is running.

## Project Structure

- `controllers/` - Request handlers
- `models/` - MongoDB schemas
- `routes/` - API route definitions
- `swagger/` - API documentation
- `scripts/` - Utility scripts
- `server.js` - Application entry point
- `db.js` - Database connection

## Technologies

- Express.js - Web framework
- MongoDB/Mongoose - Database
- Firebase Admin SDK - Authentication & notifications
- Socket.io - Real-time communication
- Stripe - Payment processing
- Swagger - API documentation
