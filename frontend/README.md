# Kalshi Demo Frontend

Clean, modern frontend matching Kalshi's styling with option insurance hedging capabilities.

## Features

- ✅ **Event List** - Displays BTC price events from Kalshi
- ✅ **Hedge Button** - Request option insurance for events
- ✅ **Strategy Display** - Shows protective put strategies with Greeks
- ✅ **Clean UI/UX** - Matches Kalshi styling, frictionless and smooth

## Setup

### Install Dependencies

```bash
cd frontend
npm install
```

### Run Development Server

```bash
npm run dev
```

Frontend will be available at `http://localhost:3000`

**Note**: Make sure the API server is running at `http://localhost:8000`

## API Integration

The frontend connects to the backend API:
- `GET /api/events` - List Kalshi events
- `POST /api/insurance` - Request insurance strategy

## Styling

Matches Kalshi's clean, modern design:
- Clean card-based layout
- Smooth animations and transitions
- Professional color scheme
- Responsive design



