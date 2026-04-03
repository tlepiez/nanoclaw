import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';

const execFileAsync = promisify(execFile);

const WHISPER_BIN =
  process.env.WHISPER_BIN || '/home/thierry/whisper.cpp/build/bin/whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  '/home/thierry/whisper.cpp/models/ggml-base.bin';

async function transcribeWithWhisper(audioBuffer: Buffer): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const tmpOgg = path.join(tmpDir, `nanoclaw-voice-${ts}.ogg`);
  const tmpWav = path.join(tmpDir, `nanoclaw-voice-${ts}.wav`);

  try {
    fs.writeFileSync(tmpOgg, audioBuffer);

    // Convert OGG/Opus (WhatsApp format) to WAV 16kHz mono (whisper-cli requirement)
    await execFileAsync('ffmpeg', [
      '-i', tmpOgg,
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      tmpWav,
      '-y',
    ]);

    const { stdout } = await execFileAsync(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-f', tmpWav,
      '--no-timestamps',
      '-nt',
      '-l', 'auto',
    ]);

    // Filter out whisper diagnostic lines, keep only transcript text
    const transcript = stdout
      .split('\n')
      .filter(
        (line) =>
          line.trim() &&
          !line.startsWith('whisper_') &&
          !line.startsWith('ggml_') &&
          !line.startsWith('system_info') &&
          !line.startsWith('main:') &&
          !line.startsWith('['),
      )
      .join(' ')
      .trim();

    return transcript || null;
  } catch (err) {
    console.error('whisper-cli transcription failed:', err);
    return null;
  } finally {
    for (const f of [tmpOgg, tmpWav]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      console.error('Failed to download audio message');
      return null;
    }

    console.log(`Downloaded audio message: ${buffer.length} bytes`);

    const transcript = await transcribeWithWhisper(buffer);
    return transcript ? transcript.trim() : null;
  } catch (err) {
    console.error('Transcription error:', err);
    return null;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
