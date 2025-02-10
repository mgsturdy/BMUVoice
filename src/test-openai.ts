import OpenAI from 'openai';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import path from 'path';
import axios from 'axios';

dotenv.config();

async function downloadTestAudio() {
  // Using a more reliable audio source
  const audioUrl = 'https://audio-samples.github.io/samples/mp3/blizzard_biased/sample-1.mp3';
  console.log('Downloading test audio file...');
  
  try {
    const response = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 15000 // Increased timeout to 15 seconds
    });
    
    const audioBuffer = Buffer.from(response.data);
    return audioBuffer;
  } catch (error) {
    console.error('Error downloading test audio:', error.message);
    throw error;
  }
}

async function testOpenAIConnection() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY is not set in .env file');
    process.exit(1);
  }

  console.log('OpenAI API Key found:', process.env.OPENAI_API_KEY.slice(0, 3) + '...' + process.env.OPENAI_API_KEY.slice(-4));

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60000, // Increased timeout to 60 seconds
    maxRetries: 5
  });

  try {
    // First test a simple models list call to verify API key and connectivity
    console.log('\nTesting OpenAI API connection...');
    const models = await openai.models.list();
    console.log('✓ Successfully connected to OpenAI API');
    console.log(`Found ${models.data.length} models`);

    // Test Whisper API with a small test audio file
    console.log('\nTesting Whisper API...');
    
    try {
      const audioBuffer = await downloadTestAudio();
      console.log('Audio file downloaded successfully');
      
      const transcription = await openai.audio.transcriptions.create({
        file: new File([audioBuffer], 'test-audio.mp3', { type: 'audio/mp3' }),
        model: 'whisper-1'
      });
      console.log('✓ Successfully transcribed audio');
      console.log('Transcription:', transcription.text);
    } catch (error) {
      console.error('\nError testing Whisper API:');
      if (error.response?.data) {
        console.error('API Response:', JSON.stringify(error.response.data, null, 2));
      } else {
        console.error(error.message);
        if (error.cause) {
          console.error('Cause:', error.cause.message);
          console.error('Stack:', error.stack);
        }
      }
    }
  } catch (error) {
    console.error('\nError connecting to OpenAI:');
    if (error.response?.data) {
      console.error('API Response:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
      if (error.cause) {
        console.error('Cause:', error.cause.message);
        console.error('Stack:', error.stack);
      }
    }
  }
}

testOpenAIConnection().catch(console.error);