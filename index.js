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
import fs from 'fs';
import path from 'path';
import os from 'os';

app.get('/download-zip', async (req, res) => {
  const folderId = req.query.folderId;
  if (!folderId) return res.status(400).json({ error: 'folderId fehlt' });

  let tmpPath;
  let isResponseSent = false;

  const sendError = (statusCode, message) => {
    if (!isResponseSent) {
      isResponseSent = true;
      res.status(statusCode).json({ error: message });
    }
  };

  const cleanup = () => {
    if (tmpPath && fs.existsSync(tmpPath)) {
      fs.unlink(tmpPath, (err) => {
        if (err) console.error('Fehler beim Löschen der temporären Datei:', err);
      });
    }
  };

  try {
    console.log(`ZIP-Download gestartet für Ordner: ${folderId}`);
    
    const files = await listAllFilesRecursive(folderId);
    if (!files.length) return sendError(404, 'Ordner leer');

    console.log(`${files.length} Dateien gefunden`);

    // Timeout für die gesamte Operation setzen
    const timeout = setTimeout(() => {
      console.error('ZIP-Download Timeout');
      cleanup();
      sendError(408, 'Download-Timeout');
    }, 300000); // 5 Minuten

    tmpPath = path.join(os.tmpdir(), `folder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.zip`);
    const output = fs.createWriteStream(tmpPath);
    const archive = archiver('zip', { 
      zlib: { level: 6 }, // Reduziere Kompression für bessere Performance
      forceLocalTime: true,
      store: files.length > 100 // Bei vielen Dateien ohne Kompression
    });

    // Verbesserte Fehlerbehandlung
    archive.on('error', (err) => {
      console.error('ZIP-Archiv Fehler:', err);
      clearTimeout(timeout);
      cleanup();
      sendError(500, 'Fehler beim Erstellen der ZIP-Datei');
    });

    archive.on('warning', (err) => {
      console.warn('ZIP-Archiv Warnung:', err);
    });

    output.on('error', (err) => {
      console.error('Output Stream Fehler:', err);
      clearTimeout(timeout);
      cleanup();
      sendError(500, 'Fehler beim Schreiben der ZIP-Datei');
    });

    archive.pipe(output);

    // Batch-Verarbeitung der Dateien
    let processedFiles = 0;
    const batchSize = 10;
    
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (file) => {
        try {
          const { data } = await drive.files.get(
            { fileId: file.id, alt: 'media' },
            { 
              responseType: 'stream',
              timeout: 30000 // 30 Sekunden Timeout pro Datei
            }
          );
          
          archive.append(data, { 
            name: file.path || file.name,
            date: new Date()
          });
          
          processedFiles++;
          if (processedFiles % 50 === 0) {
            console.log(`${processedFiles}/${files.length} Dateien verarbeitet`);
          }
        } catch (fileError) {
          console.error(`Fehler bei Datei ${file.name}:`, fileError.message);
          // Datei überspringen statt abzubrechen
        }
      }));
    }

    console.log('Alle Dateien hinzugefügt, finalisiere ZIP...');
    archive.finalize();

    output.on('close', () => {
      clearTimeout(timeout);
      console.log(`ZIP-Datei erstellt: ${archive.pointer()} bytes`);
      
      if (!isResponseSent) {
        isResponseSent = true;
        
        // Setze entsprechende Headers
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="folder.zip"');
        res.setHeader('Content-Length', fs.statSync(tmpPath).size);
        
        const fileStream = fs.createReadStream(tmpPath);
        
        fileStream.on('error', (err) => {
          console.error('Fehler beim Lesen der ZIP-Datei:', err);
          cleanup();
          if (!res.headersSent) {
            sendError(500, 'Fehler beim Senden der ZIP-Datei');
          }
        });

        fileStream.on('end', () => {
          console.log('ZIP-Download abgeschlossen');
          cleanup();
        });

        res.on('close', () => {
          console.log('Client-Verbindung geschlossen');
          cleanup();
        });

        res.on('error', (err) => {
          console.error('Response Stream Fehler:', err);
          cleanup();
        });

        fileStream.pipe(res);
      } else {
        cleanup();
      }
    });

  } catch (error) {
    console.error('Fehler in /download-zip:', error);
    cleanup();
    sendError(500, 'Interner Fehler beim ZIP-Download');
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
        body: Readable.from(file.data)
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
