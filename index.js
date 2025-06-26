import express from 'express';
import fileUpload from 'express-fileupload';
import cors from 'cors';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { Readable } from 'stream';
import archiver from 'archiver';
import { PassThrough } from 'stream';

dotenv.config();

const app = express();

app.use(cors({
  origin: ['https://www.emelieundtim.de', 'http://localhost:5173'],
  methods: ['GET', 'POST'],
}));

app.use(fileUpload());

const PORT = process.env.PORT || 3000;

const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

oauth2Client.setCredentials({
  refresh_token: process.env.REFRESH_TOKEN
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });

// Hilfsfunktion: rekursiv Dateien auflisten
const listAllFilesRecursive = async (parentId, path = '') => {
  const fileList = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      pageToken,
    });

    for (const file of res.data.files) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        const subFiles = await listAllFilesRecursive(file.id, `${path}${file.name}/`);
        fileList.push(...subFiles);
      } else {
        fileList.push({ ...file, path: `${path}${file.name}` });
      }
    }

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return fileList;
};

// ZIP-Download Route
app.get('/download-zip', async (req, res) => {
  const folderId = req.query.folderId;
  if (!folderId) {
    return res.status(400).json({ error: 'folderId ist erforderlich' });
  }

  try {
    const files = await listAllFilesRecursive(folderId);

    if (!files.length) {
      return res.status(404).json({ error: 'Keine Dateien gefunden' });
    }

    const archive = archiver('zip', { zlib: { level: 9 } });

    // Fehlerbehandlung
    archive.on('error', err => {
      console.error('ZIP-Fehler:', err);
      if (!res.headersSent) res.status(500).end('ZIP-Fehler');
    });

    // Diese Header sind entscheidend für Render-Streaming
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="folder.zip"',
      'Transfer-Encoding': 'chunked',
      'Connection': 'keep-alive',
    });

    // Start des Streams
    archive.pipe(res);

    // RAM-schonend: sequentielles Anhängen
    for (const file of files) {
      try {
        const { data } = await drive.files.get(
          { fileId: file.id, alt: 'media' },
          { responseType: 'stream' }
        );
        archive.append(data, { name: file.path || file.name });
      } catch (streamError) {
        console.error(`Fehler beim Streamen von ${file.name}:`, streamError.message);
      }
    }

    archive.finalize();
  } catch (error) {
    console.error('Fehler in /download-zip:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Interner Fehler beim Download' });
    }
  }
});






// Upload-Route
app.post('/upload-file', async (req, res) => {
  try {
    const name = req.body?.name;
    const parentFolderId = req.body?.parentFolderId;
    const file = req.files?.file;

    if (!file || !name) {
      return res.status(400).json({ success: false, error: 'Datei oder Name fehlt' });
    }

    const response = await drive.files.create({
      requestBody: {
        name: name,
        parents: [parentFolderId || 'root']
      },
      media: {
        mimeType: file.mimetype,
        // body: Readable.from(file.data)
        body: file.data instanceof Buffer
  ? Readable.from(file.data)
  : file.data
      },
      fields: 'id, name'
    });

    res.json({ success: true, fileId: response.data.id, fileName: response.data.name });

  } catch (error) {
    console.error('Fehler beim Datei-Upload:', {
      message: error.message,
      stack: error.stack,
      response: error.response?.data,
    });
    res.status(500).json({ success: false, error: 'Upload fehlgeschlagen' });
  }
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
