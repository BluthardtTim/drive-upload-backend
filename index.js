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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
  const fileIds = req.query.fileIds; // Neue Parameter für ausgewählte Dateien
  
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
    
    let files;
    
    // Unterscheidung zwischen vollständigem Ordner-Download und Auswahl-Download
    if (fileIds && fileIds.trim() !== '') {
      // Spezifische Dateiauswahl
      const selectedFileIds = fileIds.split(',').map(id => id.trim()).filter(id => id);
      console.log(`Ausgewählte Dateien: ${selectedFileIds.length}`);
      
      files = [];
      for (const fileId of selectedFileIds) {
        try {
          const fileInfo = await drive.files.get({
            fileId: fileId,
            fields: 'id, name, mimeType'
          });
          files.push({
            id: fileInfo.data.id,
            name: fileInfo.data.name,
            mimeType: fileInfo.data.mimeType,
            path: fileInfo.data.name
          });
        } catch (error) {
          console.warn(`Datei ${fileId} konnte nicht gefunden werden:`, error.message);
          // Datei überspringen, nicht den ganzen Download abbrechen
        }
      }
    } else {
      // Vollständiger Ordner-Download (bestehende Logik)
      files = await listAllFilesRecursive(folderId);
    }
    
    if (!files.length) return sendError(404, 'Keine Dateien gefunden');

    console.log(`${files.length} Dateien zum Download vorbereitet`);

    // Rest der bestehenden Logik bleibt gleich...
    const timeout = setTimeout(() => {
      console.error('ZIP-Download Timeout');
      cleanup();
      sendError(408, 'Download-Timeout');
    }, 1800000);

    tmpPath = path.join(os.tmpdir(), `folder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.zip`);
    const output = fs.createWriteStream(tmpPath);
    const archive = archiver('zip', { 
      zlib: { level: 6 },
      forceLocalTime: true,
      store: files.length > 100
    });

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
              timeout: 1800000
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




// POST /rename-file
app.post('/rename-file', async (req, res) => {
    const { fileId, newName } = req.body;
    
    // Google Drive API call to rename file
    const response = await drive.files.update({
        fileId: fileId,
        requestBody: { name: newName }
    });
    
    res.json({ success: true, file: response.data });
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







app.get('/download-zip-streaming', async (req, res) => {
  const folderId = req.query.folderId;
  const fileIds = req.query.fileIds;
  
  if (!folderId) return res.status(400).json({ error: 'folderId fehlt' });

  let isResponseSent = false;
  
  const sendError = (statusCode, message) => {
    if (!isResponseSent) {
      isResponseSent = true;
      res.status(statusCode).json({ error: message });
    }
  };

  try {
    console.log(`Streaming ZIP-Download gestartet für Ordner: ${folderId}`);
    
    let files;
    
    if (fileIds && fileIds.trim() !== '') {
      const selectedFileIds = fileIds.split(',').map(id => id.trim()).filter(id => id);
      files = [];
      
      // Parallelisierte Dateiinfo-Abfrage
      const fileInfoPromises = selectedFileIds.map(async (fileId) => {
        try {
          const fileInfo = await drive.files.get({
            fileId: fileId,
            fields: 'id, name, mimeType, size'
          });
          return {
            id: fileInfo.data.id,
            name: fileInfo.data.name,
            mimeType: fileInfo.data.mimeType,
            path: fileInfo.data.name,
            size: parseInt(fileInfo.data.size) || 0
          };
        } catch (error) {
          console.warn(`Datei ${fileId} konnte nicht gefunden werden:`, error.message);
          return null;
        }
      });
      
      const fileInfos = await Promise.all(fileInfoPromises);
      files = fileInfos.filter(f => f !== null);
    } else {
      files = await listAllFilesRecursive(folderId);
    }
    
    if (!files.length) return sendError(404, 'Keine Dateien gefunden');

    console.log(`${files.length} Dateien zum Streaming vorbereitet`);

    // Längerer Timeout für große Galerien
    const timeout = setTimeout(() => {
      console.error('Streaming ZIP-Download Timeout');
      sendError(408, 'Download-Timeout');
    }, 600000); // 10 Minuten

    // Set headers für ZIP-Download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="gallery.zip"');
    res.setHeader('Transfer-Encoding', 'chunked');
    
    // Erstelle ZIP-Archiv das direkt an Response streamt
    const archive = archiver('zip', { 
      zlib: { level: 1 }, // Niedrigere Kompression für bessere Performance
      forceLocalTime: true,
      store: false // Verwende immer Kompression für kleinere Downloads
    });

    archive.on('error', (err) => {
      console.error('ZIP-Archiv Fehler:', err);
      clearTimeout(timeout);
      if (!res.headersSent) {
        sendError(500, 'Fehler beim Erstellen der ZIP-Datei');
      }
    });

    archive.on('warning', (err) => {
      console.warn('ZIP-Archiv Warnung:', err);
    });

    // Pipe direkt zur Response
    archive.pipe(res);
    isResponseSent = true;

    let processedFiles = 0;
    const concurrencyLimit = 5; // Reduzierte Parallelität für Stabilität
    
    // Verarbeite Dateien in kleineren Batches
    for (let i = 0; i < files.length; i += concurrencyLimit) {
      const batch = files.slice(i, i + concurrencyLimit);
      
      await Promise.all(batch.map(async (file) => {
        let retries = 3;
        while (retries > 0) {
          try {
            const { data } = await drive.files.get(
              { fileId: file.id, alt: 'media' },
              { 
                responseType: 'stream',
                timeout: 60000 // Längerer Timeout pro Datei
              }
            );
            
            archive.append(data, { 
              name: file.path || file.name,
              date: new Date()
            });
            
            processedFiles++;
            if (processedFiles % 25 === 0) {
              console.log(`${processedFiles}/${files.length} Dateien verarbeitet`);
            }
            break; // Erfolgreich, verlasse Retry-Loop
            
          } catch (fileError) {
            retries--;
            console.error(`Fehler bei Datei ${file.name} (${3-retries}/3):`, fileError.message);
            
            if (retries === 0) {
              console.error(`Datei ${file.name} wird übersprungen nach 3 Versuchen`);
            } else {
              // Kurze Pause vor Retry
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }
      }));
      
      // Kleine Pause zwischen Batches um Server zu entlasten
      if (i + concurrencyLimit < files.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log('Alle Dateien hinzugefügt, finalisiere ZIP...');
    archive.finalize();

    archive.on('end', () => {
      clearTimeout(timeout);
      console.log(`Streaming ZIP-Download abgeschlossen: ${archive.pointer()} bytes`);
    });

    res.on('close', () => {
      console.log('Client-Verbindung geschlossen');
      clearTimeout(timeout);
    });

    res.on('error', (err) => {
      console.error('Response Stream Fehler:', err);
      clearTimeout(timeout);
    });

  } catch (error) {
    console.error('Fehler in /download-zip-streaming:', error);
    clearTimeout(timeout);
    if (!isResponseSent) {
      sendError(500, 'Interner Fehler beim Streaming ZIP-Download');
    }
  }
});







app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
