# SMS Opt-In/Opt-Out Manager for Vonage

A web application to manage SMS opt-in/opt-out preferences and send SMS with automatic blocklist checking using the Vonage SMS API.

## Features

- **Dashboard**: View opt-in/opt-out statistics for the last 24 hours
- **Send SMS**: Send messages via UI or API with automatic opt-out blocking
- **Configuration**: Connect to your Vonage account and set up multiple opt-out numbers
- **Reports**: View and export opt-in/opt-out history by date range
- **Manual Management**: Manually opt-in or opt-out phone numbers
- **API**: REST API endpoints to integrate SMS sending into your applications

## How It Works

1. When someone sends your opt-out phrase (e.g., "STOP") to your Vonage number, they are added to the blocklist
2. When someone sends your opt-in phrase (e.g., "START"), they are removed from the blocklist
3. **All SMS sent through this app (UI or API) automatically checks the blocklist** - opted-out numbers are rejected

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Server

```bash
npm start
```

The app will run on http://localhost:3000

### 3. Configure Your Vonage Account

1. Open the app in your browser
2. Go to the **Configuration** tab
3. Enter your Vonage API Key and API Secret, click **Save Credentials**
4. Click **Load Account Numbers** to fetch your Vonage numbers
5. Click **Add Another Opt-Out Number** to configure opt-out settings
6. Select a number and set your Opt-Out/Opt-In phrases (default: STOP/START)
7. Click **Save**

### 4. Set Up Webhooks in Vonage Dashboard

1. Log into your [Vonage Dashboard](https://dashboard.nexmo.com)
2. Go to Numbers > Your Numbers
3. Click "Edit" on each opt-out number
4. Set the Inbound Webhook URL to: `https://your-server.com/webhooks/inbound`
5. Set HTTP Method to POST
6. Save changes

---

## Sending SMS via API

All SMS sent through these endpoints will automatically check the blocklist. Opted-out numbers are rejected.

### SDK Compatibility Mode (NEW)

This endpoint mimics `https://rest.nexmo.com/sms/json` so you can use the Vonage SDK with just a base URL change.

**Java SDK Example:**
```java
HttpConfig httpConfig = HttpConfig.builder()
    .baseUri("https://your-vcr-url.vonage.cloud")
    .build();

VonageClient client = VonageClient.builder()
    .apiKey("your-key")
    .apiSecret("your-secret")
    .httpConfig(httpConfig)
    .build();

// Use SDK normally - requests go through opt-out proxy
smsClient.submitMessage(textMessage);
```

**Direct API Call:**
```bash
curl -X POST https://your-server.com/sms/json \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "your_key",
    "api_secret": "your_secret",
    "to": "447123456789",
    "from": "447418317717",
    "text": "Hello, this is a test message"
  }'
```

**Response format matches Vonage API exactly:**
```json
{
  "message-count": "1",
  "messages": [{
    "to": "447123456789",
    "message-id": "abc123def456",
    "status": "0",
    "remaining-balance": "1.234",
    "message-price": "0.0333"
  }]
}
```

**Blocked Response (status 99):**
```json
{
  "message-count": "1",
  "messages": [{
    "to": "447123456789",
    "status": "99",
    "error-text": "Number is opted out"
  }]
}
```

### Send Single SMS

```bash
curl -X POST https://your-server.com/api/send \
  -H "Content-Type: application/json" \
  -d '{
    "to": "447123456789",
    "from": "447418317717",
    "text": "Hello, this is a test message"
  }'
```

**Success Response (200):**
```json
{
  "success": true,
  "to": "447123456789",
  "messageId": "abc123def456",
  "status": "sent"
}
```

**Blocked Response (403):**
```json
{
  "error": "Number is opted out",
  "to": "447123456789",
  "blocked": true,
  "status": "rejected"
}
```

### Send Bulk SMS

```bash
curl -X POST https://your-server.com/api/send/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "recipients": ["447123456789", "447987654321", "447555555555"],
    "from": "447418317717",
    "text": "Hello everyone!"
  }'
```

**Response (200):**
```json
{
  "summary": {
    "total": 3,
    "sent": 2,
    "blocked": 1,
    "failed": 0
  },
  "results": {
    "sent": [
      { "to": "447123456789", "messageId": "abc123" },
      { "to": "447555555555", "messageId": "def456" }
    ],
    "blocked": [
      { "to": "447987654321", "reason": "opted-out" }
    ],
    "failed": []
  }
}
```

### Check If Number Is Blocked

```bash
curl https://your-server.com/api/check/447123456789
```

**Response:**
```json
{
  "number": "447123456789",
  "blocked": true
}
```

---

## All API Endpoints

### SMS Sending

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sms/json` | POST | SDK-compatible send (Vonage API format) |
| `/api/send` | POST | Send single SMS (with blocklist check) |
| `/api/send/bulk` | POST | Send bulk SMS (with blocklist check) |
| `/api/check/:number` | GET | Check if a number is blocked |

### Configuration

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/credentials` | GET | Get API credentials status |
| `/api/credentials` | POST | Save and lock API credentials |
| `/api/credentials/unlock` | POST | Unlock credentials for editing |
| `/api/numbers` | GET | Fetch numbers from Vonage account |
| `/api/config` | GET | Get opt-out configurations |
| `/api/config/add` | POST | Add new opt-out configuration |
| `/api/config/:id` | PUT | Update opt-out configuration |
| `/api/config/:id` | DELETE | Delete opt-out configuration |

### Opt-Out Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/optouts` | GET | Get list of opted-out numbers |
| `/api/optout` | POST | Manually opt-out a number |
| `/api/optin` | POST | Manually opt-in a number |
| `/api/stats` | GET | Get opt-in/opt-out stats (last 24h) |
| `/api/history` | GET | Get activity history (supports filters) |

### Webhooks

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhooks/inbound` | POST | Webhook for incoming SMS |
| `/webhooks/status` | POST | Webhook for delivery receipts |

---

## Response Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Missing fields or invalid request |
| 403 | Number is opted out (blocked) - for `/api/send` |
| 500 | Server error |

### Vonage-format Status Codes (for `/sms/json`)

| Status | Description |
|--------|-------------|
| 0 | Success |
| 2 | Missing/invalid parameters |
| 5 | Internal error |
| 99 | Number is opted out (custom status) |

---

## Deployment

### Vonage Cloud Runtime (VCR)

1. Edit `vcr.yml` and add your credentials:
   - Replace `App ID here` with your Vonage Application ID
   - Replace `API Key here` with your Vonage API Key
   - Replace `API Secret here` with your Vonage API Secret

2. Deploy to VCR:
```bash
vcr deploy
```

3. Your app will be available at the VCR URL provided after deployment.

### Other Platforms

For other platforms (Heroku, Railway, DigitalOcean, AWS), deploy as a standard Node.js app:

- Heroku
- Railway
- DigitalOcean
- AWS Elastic Beanstalk

Set environment variables:
- `VONAGE_API_KEY` - Your Vonage API Key
- `VONAGE_API_SECRET` - Your Vonage API Secret

Update your Vonage webhook URL to point to your production server.

## Data Storage

Data is stored in JSON files in the `data/` directory:

- `credentials.json` - API credentials (locked)
- `config.json` - Opt-out number configurations
- `optouts.json` - List of opted-out numbers
- `history.json` - Activity history

For production, consider migrating to a database like MongoDB or PostgreSQL.
