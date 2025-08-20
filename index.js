// This is my Code for the backend hosted on railway 


// index.js:

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
    }, 300000);

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
              timeout: 30000
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


// TEST-Route mit allen Optimierungen + HTTP/2 Fix
app.get('/download-zip-testing', async (req, res) => {
  const folderId = req.query.folderId;
  const fileIds = req.query.fileIds; // Parameter für ausgewählte Dateien
  
  if (!folderId) return res.status(400).json({ error: 'folderId fehlt' });

  let tmpPath;
  let isResponseSent = false;
  let heartbeatInterval;

  const sendError = (statusCode, message) => {
    if (!isResponseSent) {
      isResponseSent = true;
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      res.status(statusCode).json({ error: message });
    }
  };

  const cleanup = () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (tmpPath && fs.existsSync(tmpPath)) {
      // Verzögertes Cleanup für bessere Stabilität
      setTimeout(() => {
        fs.unlink(tmpPath, (err) => {
          if (err) console.error('Fehler beim Löschen der temporären Datei:', err);
          else console.log('Temporäre Datei erfolgreich gelöscht (TESTING)');
        });
      }, 5000); // 5 Sekunden Delay
    }
  };

  try {
    console.log(`ZIP-Download TESTING gestartet für Ordner: ${folderId}`);
    
    let files;
    
    // Unterscheidung zwischen vollständigem Ordner-Download und Auswahl-Download
    if (fileIds && fileIds.trim() !== '') {
      // Spezifische Dateiauswahl
      const selectedFileIds = fileIds.split(',').map(id => id.trim()).filter(id => id);
      console.log(`TESTING - Ausgewählte Dateien: ${selectedFileIds.length}`);
      
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
          console.warn(`TESTING - Datei ${fileId} konnte nicht gefunden werden:`, error.message);
          // Datei überspringen, nicht den ganzen Download abbrechen
        }
      }
    } else {
      // Vollständiger Ordner-Download (optimierte Logik)
      files = await listAllFilesRecursive(folderId);
    }
    
    if (!files.length) return sendError(404, 'Keine Dateien gefunden');

    console.log(`TESTING - ${files.length} Dateien zum Download vorbereitet`);

    // Timeout auf 60 Minuten für sehr große Galerien erhöht
    const timeout = setTimeout(() => {
      console.error('ZIP-Download TESTING Timeout');
      cleanup();
      sendError(408, 'Download-Timeout (Testing)');
    }, 3600000); // 60 Minuten

    // HTTP/2 Protocol Error Fix: Explizite Headers setzen
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=3600, max=1000');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="folder-testing.zip"');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // Nginx buffering deaktivieren
    
    // Verhindere HTTP/2 Probleme durch forciertes Chunked Transfer
    res.setHeader('Transfer-Encoding', 'chunked');
    
    console.log('TESTING - Headers gesetzt, starte direktes Streaming...');

    // DIREKTES STREAMING ohne temporäre Datei (HTTP/2 Fix)
    const archive = archiver('zip', { 
      zlib: { level: 0 }, // Keine Kompression für maximale Geschwindigkeit
      forceLocalTime: true,
      store: true // Immer store-only für große Dateien
    });

    // Heartbeat um Verbindung aufrecht zu erhalten
    heartbeatInterval = setInterval(() => {
      if (!res.headersSent) {
        console.log('TESTING - Sende Heartbeat Header...');
        res.write(''); // Leeren Chunk senden
      }
    }, 30000); // Alle 30 Sekunden

    archive.on('error', (err) => {
      console.error('ZIP-Archiv TESTING Fehler:', err);
      clearTimeout(timeout);
      cleanup();
      if (!isResponseSent) {
        sendError(500, 'Fehler beim Erstellen der ZIP-Datei (Testing)');
      }
    });

    archive.on('warning', (err) => {
      console.warn('ZIP-Archiv TESTING Warnung:', err);
    });

    // Pipe direkt in Response (kein temp file)
    archive.pipe(res);

    let processedFiles = 0;
    const batchSize = 1; // Auf 1 reduziert für maximale Stabilität
    
    console.log(`TESTING - Starte Verarbeitung mit Batch-Size: ${batchSize} (DIRECT STREAMING)`);
    
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (file) => {
        try {
          console.log(`TESTING - Verarbeite Datei ${processedFiles + 1}/${files.length}: ${file.name}`);
          
          const { data } = await drive.files.get(
            { fileId: file.id, alt: 'media' },
            { 
              responseType: 'stream',
              timeout: 120000 // Timeout auf 2 Minuten pro Datei erhöht
            }
          );
          
          archive.append(data, { 
            name: file.path || file.name,
            date: new Date()
          });
          
          processedFiles++;
          if (processedFiles % 10 === 0) { // Noch häufigere Updates
            console.log(`TESTING - ${processedFiles}/${files.length} Dateien verarbeitet (${Math.round(processedFiles/files.length*100)}%)`);
          }
          
          // Kurze Pause zwischen Dateien für Stabilität
          await new Promise(resolve => setTimeout(resolve, 100));
          
        } catch (fileError) {
          console.error(`TESTING - Datei ${file.name} übersprungen:`, fileError.message);
          processedFiles++; // Zähle trotzdem weiter
          // Weiter mit nächster Datei statt Abbruch der gesamten Operation
        }
      }));
    }

    console.log('TESTING - Alle Dateien hinzugefügt, finalisiere ZIP...');
    archive.finalize();

    archive.on('end', () => {
      clearTimeout(timeout);
      cleanup();
      console.log(`TESTING - ZIP-Stream abgeschlossen, ${archive.pointer()} bytes gesendet`);
      isResponseSent = true;
    });

    res.on('close', () => {
      console.log('TESTING - Client-Verbindung geschlossen');
      cleanup();
    });

    res.on('error', (err) => {
      console.error('TESTING - Response Stream Fehler:', err);
      cleanup();
    });

  } catch (error) {
    console.error('TESTING - Fehler in /download-zip-testing:', error);
    cleanup();
    if (!isResponseSent) {
      sendError(500, 'Interner Fehler beim ZIP-Download (Testing)');
    }
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

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});

// Automatisches Cleanup für alte temporäre Dateien
setInterval(() => {
  try {
    const tempDir = os.tmpdir();
    const files = fs.readdirSync(tempDir);
    
    const oldZipFiles = files
      .filter(file => file.startsWith('folder-') && file.endsWith('.zip'))
      .filter(file => {
        try {
          const filePath = path.join(tempDir, file);
          const stats = fs.statSync(filePath);
          const ageInMinutes = (Date.now() - stats.mtime.getTime()) / (1000 * 60);
          return ageInMinutes > 60; // Dateien älter als 60 Minuten
        } catch (error) {
          return false;
        }
      });
    
    oldZipFiles.forEach(file => {
      try {
        const filePath = path.join(tempDir, file);
        fs.unlinkSync(filePath);
        console.log(`Alte temporäre Datei gelöscht: ${file}`);
      } catch (error) {
        console.error(`Fehler beim Löschen von ${file}:`, error.message);
      }
    });
    
    if (oldZipFiles.length > 0) {
      console.log(`Cleanup abgeschlossen: ${oldZipFiles.length} alte Dateien entfernt`);
    }
  } catch (error) {
    console.error('Fehler beim automatischen Cleanup:', error.message);
  }
}, 30 * 60 * 1000); // Alle 30 Minuten
