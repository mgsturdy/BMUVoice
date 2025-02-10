import express from 'express';
import dotenv from 'dotenv';
import twilio from 'twilio';
import axios from 'axios';
import { Readable } from 'stream';
import { File } from '@web-std/file';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import FormData from 'form-data';

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/audio', express.static('audio'));

const audioDir = path.join(process.cwd(), 'audio');
fs.mkdir(audioDir, { recursive: true }).catch(console.error);

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
const voiceId = process.env.ELEVENLABS_VOICE_ID;
const assemblyAiKey = process.env.ASSEMBLYAI_API_KEY;

if (!accountSid || !authToken) {
  console.error('Missing Twilio credentials in .env file');
  process.exit(1);
}

if (!elevenLabsKey || !voiceId) {
  console.error('Missing ElevenLabs credentials in .env file');
  process.exit(1);
}

if (!assemblyAiKey) {
  console.error('Missing AssemblyAI API key in .env file');
  process.exit(1);
}

const twilioClient = twilio(accountSid, authToken);

interface Resident {
  name: string;
  phoneNumber: string;
  aliases?: string[];
}

interface DeliveryPerson {
  orderId: string;
  name: string;
  expectedArrival: Date;
  phoneNumber?: string;
  verificationCode: string;
}

const residents: Resident[] = [
  { 
    name: 'Matt', 
    phoneNumber: '+13107959382',
    aliases: ['Matthew', 'Mat']
  },
  { 
    name: 'Lindsay', 
    phoneNumber: '+12049991981',
    aliases: ['Lindsey', 'Linsey', 'Lyndsay']
  }
];

const activeDeliveries = new Map<string, DeliveryPerson>();
const audioCache = new Map<string, string>();

async function generateAndCacheAudio(text: string): Promise<string> {
  const hash = Buffer.from(text).toString('base64').replace(/[/+=]/g, '_');
  const filename = `${hash}.mp3`;
  const filePath = path.join(audioDir, filename);
  
  if (audioCache.has(text)) {
    return audioCache.get(text)!;
  }

  try {
    await fs.access(filePath);
    const publicUrl = `/audio/${filename}`;
    audioCache.set(text, publicUrl);
    return publicUrl;
  } catch {
    console.log('Generating audio for:', text);
    
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      },
      {
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': elevenLabsKey,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer'
      }
    );

    await fs.writeFile(filePath, response.data);
    const publicUrl = `/audio/${filename}`;
    audioCache.set(text, publicUrl);
    return publicUrl;
  }
}

async function downloadAudio(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    auth: {
      username: accountSid,
      password: authToken
    }
  });
  return Buffer.from(response.data);
}

async function uploadWithRetry(audioData: Buffer, maxRetries = 3): Promise<string> {
  // Add a delay before first attempt to ensure audio is fully processed
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Upload attempt ${attempt}/${maxRetries}`);
      
      // Create form data
      const form = new FormData();
      const stream = Readable.from(audioData);
      form.append('audio', stream, {
        filename: 'audio.mp3',
        contentType: 'audio/mpeg'
      });

      // Add exponential backoff between retries
      if (attempt > 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
      }

      const uploadResponse = await axios.post(
        'https://api.assemblyai.com/v2/upload',
        form,
        {
          headers: {
            ...form.getHeaders(),
            'authorization': assemblyAiKey
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 30000 // 30 second timeout
        }
      );

      console.log('Upload response:', uploadResponse.data);

      if (!uploadResponse.data || !uploadResponse.data.upload_url) {
        throw new Error('Invalid upload response');
      }

      return uploadResponse.data.upload_url;
    } catch (error) {
      console.error(`Upload attempt ${attempt} failed:`, error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      
      if (attempt === maxRetries) throw error;
    }
  }
  throw new Error('Upload failed after retries');
}

async function transcribeAudio(audioUrl: string): Promise<string> {
  try {
    console.log('Downloading audio from:', audioUrl);
    const audioData = await downloadAudio(audioUrl);
    console.log('Audio downloaded, size:', audioData.length, 'bytes');

    if (audioData.length < 1024) {
      console.warn('Warning: Audio file is very small:', audioData.length, 'bytes');
      // Add a longer delay for small files
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    const uploadUrl = await uploadWithRetry(audioData);
    console.log('Upload successful, URL:', uploadUrl);

    // Add delay before transcription request
    await new Promise(resolve => setTimeout(resolve, 2000));

    const transcriptResponse = await axios.post(
      'https://api.assemblyai.com/v2/transcript',
      {
        audio_url: uploadUrl,
        language_detection: true
      },
      {
        headers: {
          'authorization': assemblyAiKey,
          'content-type': 'application/json'
        }
      }
    );

    const transcriptId = transcriptResponse.data.id;
    console.log('Transcript ID:', transcriptId);

    let attempt = 0;
    const maxPollingAttempts = 30;
    
    while (attempt < maxPollingAttempts) {
      const pollingResponse = await axios.get(
        `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
        {
          headers: {
            'authorization': assemblyAiKey
          }
        }
      );

      console.log('Polling status:', pollingResponse.data.status);

      if (pollingResponse.data.status === 'completed') {
        return pollingResponse.data.text;
      } else if (pollingResponse.data.status === 'error') {
        throw new Error(`Transcription failed: ${pollingResponse.data.error}`);
      }

      attempt++;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error('Transcription timed out');
  } catch (error) {
    console.error('Error in transcription:', error);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
    throw error;
  }
}

function levenshteinDistance(str1: string, str2: string): number {
  const track = Array(str2.length + 1).fill(null).map(() =>
    Array(str1.length + 1).fill(null));
  
  for (let i = 0; i <= str1.length; i += 1) {
    track[0][i] = i;
  }
  for (let j = 0; j <= str2.length; j += 1) {
    track[j][0] = j;
  }

  for (let j = 1; j <= str2.length; j += 1) {
    for (let i = 1; i <= str1.length; i += 1) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      track[j][i] = Math.min(
        track[j][i - 1] + 1,
        track[j - 1][i] + 1,
        track[j - 1][i - 1] + indicator
      );
    }
  }

  return track[str2.length][str1.length];
}

function findResident(transcript: string): Resident | null {
  const words = transcript
    .toLowerCase()
    .replace(/[.,!?]/g, '')
    .trim()
    .split(/\s+/);
    
  const nameWord = words.find(word => !['thank', 'you'].includes(word)) || '';
  console.log('Extracted name word:', nameWord);

  let bestMatch: { resident: Resident | null; distance: number } = {
    resident: null,
    distance: Infinity
  };

  residents.forEach(resident => {
    const mainNameDistance = levenshteinDistance(
      nameWord,
      resident.name.toLowerCase()
    );
    
    console.log(`Distance for ${resident.name}:`, mainNameDistance);
    
    if (mainNameDistance < bestMatch.distance) {
      bestMatch = { resident, distance: mainNameDistance };
    }

    resident.aliases?.forEach(alias => {
      const aliasDistance = levenshteinDistance(
        nameWord,
        alias.toLowerCase()
      );
      console.log(`Distance for alias ${alias}:`, aliasDistance);
      
      if (aliasDistance < bestMatch.distance) {
        bestMatch = { resident, distance: aliasDistance };
      }
    });
  });

  console.log('Best match found:', {
    name: bestMatch.resident?.name,
    distance: bestMatch.distance
  });

  return bestMatch.distance <= 2 ? bestMatch.resident : null;
}

function findPerson(transcript: string): { type: 'resident' | 'delivery', person: Resident | DeliveryPerson | null } {
  const words = transcript.toLowerCase().split(/\s+/);
  const deliveryCompanies = ['amazon', 'fedex', 'ups'];
  
  const isDelivery = deliveryCompanies.some(company => words.includes(company));

  if (isDelivery) {
    return { 
      type: 'delivery', 
      person: {
        orderId: 'manual-delivery',
        name: 'Delivery Person',
        expectedArrival: new Date(),
        verificationCode: 'APPROVED'
      }
    };
  }

  const resident = findResident(transcript);
  return { type: 'resident', person: resident };
}

app.get('/test', (req, res) => {
  res.send('Server is running!');
});

app.post('/twilio/incoming', async (req, res) => {
  console.log('Received incoming call');
  const twiml = new twilio.twiml.VoiceResponse();
  
  try {
    const greeting = "Hey! I'm Matt's AI Concierge. I know we sound similar. Do you want me to ring Matt, Lindsay or both? Alternatively, if you have a package, please say your delivery company name";
    const audioUrl = await generateAndCacheAudio(greeting);
    const fullUrl = `${req.protocol}://${req.get('host')}${audioUrl}`;
    twiml.play(fullUrl);
    
    twiml.record({
      action: '/twilio/handle-recording',
      method: 'POST',
      playBeep: true,
      timeout: 3,
      maxLength: 5
    });
  } catch (error) {
    console.error('Error generating greeting:', error);
    twiml.say(
      { voice: 'alice' },
      "Hey! I'm Matt's AI Concierge. I know we sound similar. Do you want me to ring Matt, Lindsay or both? Alternatively, if you have a package, please say your delivery company name"
    );
  }
  
  console.log('Sending TwiML response');
  res.type('text/xml');
  res.send(twiml.toString());
});

async function waitForRecording(recordingSid: string, maxAttempts = 10): Promise<twilio.Recording> {
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`Checking recording status (attempt ${attempt}/${maxAttempts})`);
    try {
      const recording = await twilioClient.recordings(recordingSid).fetch();
      
      if (recording.status === 'completed') {
        return recording;
      }
      
      if (recording.status === 'failed') {
        throw new Error('Recording failed to process');
      }
      
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      await new Promise(resolve => setTimeout(resolve, delay));
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  throw new Error('Recording did not complete processing in time');
}

app.post('/twilio/handle-recording', async (req, res) => {
  console.log('Received recording webhook');
  const twiml = new twilio.twiml.VoiceResponse();
  
  try {
    const recordingSid = req.body.RecordingSid;
    console.log('Recording webhook body:', req.body);
    
    if (!recordingSid) {
      throw new Error('No recording SID provided');
    }
    
    console.log('Waiting for recording to be ready:', recordingSid);
    
    const recording = await waitForRecording(recordingSid);
    console.log('Recording is ready:', recording);
    
    const recordingUrl = recording.mediaUrl;
    if (!recordingUrl) {
      throw new Error('No media URL available');
    }
    
    const mp3Url = `${recordingUrl}.mp3`;
    console.log('Starting AssemblyAI transcription...');
    
    try {
      const transcript = await transcribeAudio(mp3Url);
      console.log('Transcription result:', transcript);
      
      const result = findPerson(transcript);
      console.log('Found person:', result);
      
      let responseText;
      if (result.type === 'delivery') {
        responseText = `Access granted. Please leave the package in the lobby.`;
      } else {
        if (result.person) {
          responseText = `Great, connecting you to ${(result.person as Resident).name} now.`;
        } else {
          responseText = `I'm sorry, I couldn't find who you're looking for. Please try again.`;
        }
      }

      try {
        const audioUrl = await generateAndCacheAudio(responseText);
        const fullUrl = `${req.protocol}://${req.get('host')}${audioUrl}`;
        twiml.play(fullUrl);
        
        if (result.type === 'resident' && result.person) {
          twiml.dial((result.person as Resident).phoneNumber);
        }
      } catch (error) {
        console.error('Error generating response audio:', error);
        twiml.say({ voice: 'alice' }, responseText);
        if (result.type === 'resident' && result.person) {
          twiml.dial((result.person as Resident).phoneNumber);
        }
      }
    } catch (error) {
      console.error('Error during processing:', error);
      const errorText = 'Sorry, I had trouble understanding that. Please try again.';
      try {
        const audioUrl = await generateAndCacheAudio(errorText);
        const fullUrl = `${req.protocol}://${req.get('host')}${audioUrl}`;
        twiml.play(fullUrl);
      } catch {
        twiml.say({ voice: 'alice' }, errorText);
      }
    }
  } catch (error) {
    console.error('Error handling recording:', error);
    const errorText = 'Sorry, there was an error processing your request. Please try again.';
    try {
      const audioUrl = await generateAndCacheAudio(errorText);
      const fullUrl = `${req.protocol}://${req.get('host')}${audioUrl}`;
      twiml.play(fullUrl);
    } catch {
      twiml.say({ voice: 'alice' }, errorText);
    }
  }
  
  twiml.hangup();
  console.log('Sending TwiML response:', twiml.toString());
  res.type('text/xml');
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Available routes:');
  console.log('  GET /test');
  console.log('  POST /twilio/incoming');
  console.log('  POST /twilio/handle-recording');
  console.log('\nMake sure to:');
  console.log('1. Start ngrok: ngrok http 3000');
  console.log('2. Update your Twilio phone number webhook with the ngrok URL + /twilio/incoming');
});