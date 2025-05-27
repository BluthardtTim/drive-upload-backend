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

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const response = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [parentFolderId || 'root']
      },
      media: {},
      fields: 'id',
    }, {
      headers: {
        'X-Upload-Content-Type': 'application/octet-stream',
      },
      params: {
        uploadType: 'resumable'
      }
    });

    const uploadUrl = response.headers.location;
    res.json({ success: true, uploadUrl });

  } catch (error) {
    console.error('Fehler beim Erstellen der Upload-URL:', error);
    res.status(500).json({ success: false, error: 'Fehler beim Erstellen der Upload-URL' });
  }
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
