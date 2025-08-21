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

// Increase memory limit for Node.js process
if (process.env.NODE_OPTIONS && !process.env.NODE_OPTIONS.includes('--max-old-space-size')) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS} --max-old-space-size=7168`;
} else if (!process.env.NODE_OPTIONS) {
  process.env.NODE_OPTIONS = '--max-old-space-size=7168';
}

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

// Memory monitoring function
const logMemoryUsage = (label = '') => {
  const used = process.memoryUsage();
  console.log(`Memory Usage ${label}:`);
  for (let key in used) {
    console.log(`${key}: ${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB`);
  }
  
  // Force garbage collection if memory usage is high
  if (used.heapUsed > 6 * 1024 * 1024 * 1024) { // 6GB
    console.log('High memory usage detected, forcing garbage collection...');
    if (global.gc) {
      global.gc();
    }
  }
};

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

// ZIP-Download Route - Optimized for large galleries with streaming
import fs from 'fs';
import path from 'path';
import os from 'os';

app.get('/download-zip', async (req, res) => {
  const folderId = req.query.folderId;
  const fileIds = req.query.fileIds; // Neue Parameter für ausgewählte Dateien
  
  if (!folderId) return res.status(400).json({ error: 'folderId fehlt' });

  let isResponseSent = false;

  const sendError = (statusCode, message) => {
    if (!isResponseSent) {
      isResponseSent = true;
      res.status(statusCode).json({ error: message });
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

    // Streaming ZIP creation - no temporary file needed
    const timeout = setTimeout(() => {
      console.error('ZIP-Download Timeout');
      if (!isResponseSent) {
        sendError(408, 'Download-Timeout');
      }
    }, 600000); // Erhöhtes Timeout für große Downloads

    // Set response headers immediately
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="gallery.zip"');
    res.setHeader('Transfer-Encoding', 'chunked');
    
    // Create streaming archive directly to response
    const archive = archiver('zip', { 
      zlib: { level: 1 }, // Reduzierte Kompression für bessere Performance
      forceLocalTime: true,
      store: files.length > 200 // Store files ohne Kompression bei vielen Dateien
    });

    archive.on('error', (err) => {
      console.error('ZIP-Archiv Fehler:', err);
      clearTimeout(timeout);
      if (!isResponseSent) {
        isResponseSent = true;
        if (!res.headersSent) {
          sendError(500, 'Fehler beim Erstellen der ZIP-Datei');
        }
      }
    });

    archive.on('warning', (err) => {
      console.warn('ZIP-Archiv Warnung:', err);
    });

    res.on('error', (err) => {
      console.error('Response Stream Fehler:', err);
      clearTimeout(timeout);
    });

    res.on('close', () => {
      console.log('Client-Verbindung geschlossen');
      clearTimeout(timeout);
    });

    // Pipe archive directly to response
    archive.pipe(res);

    let processedFiles = 0;
    const batchSize = 5; // Kleinere Batches für bessere RAM-Verwaltung
    
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      
      // Sequenzielle Verarbeitung statt parallel für bessere RAM-Kontrolle
      for (const file of batch) {
        try {
          const { data } = await drive.files.get(
            { fileId: file.id, alt: 'media' },
            { 
              responseType: 'stream',
              timeout: 45000
            }
          );
          
          // Stream direkt ins Archiv ohne Zwischenspeicherung
          archive.append(data, { 
            name: file.path || file.name,
            date: new Date()
          });
          
          processedFiles++;
          if (processedFiles % 25 === 0) {
            console.log(`${processedFiles}/${files.length} Dateien verarbeitet`);
          }
          
          // Kurze Pause zwischen Dateien um RAM zu entlasten
          if (processedFiles % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 50));
            // Log memory usage every 25 files
            if (processedFiles % 25 === 0) {
              logMemoryUsage(`after ${processedFiles} files`);
            }
          }
          
        } catch (fileError) {
          console.error(`Fehler bei Datei ${file.name}:`, fileError.message);
        }
      }
    }

    console.log('Alle Dateien hinzugefügt, finalisiere ZIP...');
    
    archive.finalize();
    
    archive.on('end', () => {
      clearTimeout(timeout);
      console.log(`ZIP-Download abgeschlossen: ${archive.pointer()} bytes`);
      isResponseSent = true;
    });

  } catch (error) {
    console.error('Fehler in /download-zip:', error);
    if (!isResponseSent) {
      sendError(500, 'Interner Fehler beim ZIP-Download');
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
