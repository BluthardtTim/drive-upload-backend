import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

oauth2Client.setCredentials({
  refresh_token: process.env.REFRESH_TOKEN
});

app.post('/create-upload-url', async (req, res) => {
  try {
    const { filename, parentFolderId } = req.body;

    const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';

    const token = await oauth2Client.getAccessToken();

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token.token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'application/octet-stream',
      },
      body: JSON.stringify({
        name: filename,
        parents: [parentFolderId || 'root'],
      })
    });

    const uploadUrl = response.headers.get('location');

    if (!uploadUrl) {
      throw new Error('Google Drive hat keine Upload-URL zurückgegeben');
    }

    res.json({ success: true, uploadUrl });

  } catch (error) {
    console.error('Fehler beim Erstellen der Upload-URL:', {
      message: error.message,
      response: error.response?.data,
      code: error.code,
      stack: error.stack,
    });

    res.status(500).json({ success: false, error: 'Fehler beim Erstellen der Upload-URL' });
  }
});




app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
