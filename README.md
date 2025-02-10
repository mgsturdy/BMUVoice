# AI Voice Concierge

An AI-powered voice concierge system built with Twilio, ElevenLabs, and AssemblyAI. The system answers calls, processes voice input, and connects callers with residents or handles delivery personnel.

## Prerequisites

- Node.js (v18 or higher)
- npm
- ngrok account
- Twilio account and phone number
- ElevenLabs account and API key
- AssemblyAI account and API key

## Installation

1. Clone the repository:
```bash

```

2. Install dependencies:
```bash
npm install
```

3. Install ngrok globally:
```bash
npm install -g ngrok
```

4. Create a `.env` file in the root directory with your credentials:
```env
TWILIO_ACCOUNT_SID=your_account_sid_here
TWILIO_AUTH_TOKEN=your_auth_token_here
ASSEMBLYAI_API_KEY=your_assemblyai_api_key_here
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
ELEVENLABS_VOICE_ID=your_voice_id_here
PORT=3000
```

## Running Locally

1. Start the server:
```bash
npm start
```

2. In a new terminal, start ngrok:
```bash
ngrok http 3000
```

3. Copy the HTTPS URL provided by ngrok (e.g., `https://your-ngrok-url.ngrok-free.app`)

## Twilio Configuration

1. Go to your [Twilio Console](https://console.twilio.com)
2. Select your phone number
3. Under "Voice & Fax", find "A Call Comes In"
4. Set the webhook URL to your ngrok URL + `/twilio/incoming`:
   - Example: `https://your-ngrok-url.ngrok-free.app/twilio/incoming`
5. Set the HTTP method to POST

## Usage

The system will now:
1. Answer incoming calls with an AI voice prompt
2. Record the caller's response
3. Process the audio to identify the requested resident
4. Either connect the call to the resident or handle delivery personnel

## Important Notes

- Keep your `.env` file secure and never commit it to version control
- The ngrok URL changes each time you restart ngrok
- Update the Twilio webhook URL whenever the ngrok URL changes
- For production, use a stable domain instead of ngrok

## License

MIT
