// This is my Code for the backend hosted on railway 

// If you make changes to the code duplicate the url add a new one with the ending - testing to always have the old one running
// and the new one for testing. If everything works fine you can delete the old one


// index.js:
import express from 'express';
import fileUpload from 'express-fileupload';
import cors from 'cors';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { Readable } from 'stream';
import archiver from 'archiver';
import { PassThrough } from 'stream';

// Enable garbage collection in production
if (process.env.NODE_ENV === 'production') {
  // Set memory limits and garbage collection flags
  process.env.NODE_OPTIONS = '--max-old-space-size=7500 --expose-gc';
}

dotenv.config();

const app = express();

// Add memory monitoring
const logMemoryUsage = () => {
  const used = process.memoryUsage();
  console.log(`Memory Usage: RSS: ${Math.round(used.rss / 1024 / 1024)}MB, Heap Used: ${Math.round(used.heapUsed / 1024 / 1024)}MB, Heap Total: ${Math.round(used.heapTotal / 1024 / 1024)}MB`);
};

// Log memory usage every 5 minutes
setInterval(logMemoryUsage, 5 * 60 * 1000);

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
  const fileIds = req.query.fileIds;
  
  if (!folderId) return res.status(400).json({ error: 'folderId fehlt' });

  let isResponseSent = false;
  let processedFiles = 0;

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
        }
      }
    } else {
      files = await listAllFilesRecursive(folderId);
    }
    
    if (!files.length) return sendError(404, 'Keine Dateien gefunden');

    console.log(`${files.length} Dateien zum Download vorbereitet`);

    // Set timeout based on number of files (more time for larger galleries)
    const timeout = setTimeout(() => {
      console.error('ZIP-Download Timeout');
      sendError(408, 'Download-Timeout');
    }, Math.max(1800000, files.length * 5000)); // Min 30 min, +5s per file

    // Stream ZIP directly to response - NO temporary file
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="folder.zip"');
    res.setHeader('Transfer-Encoding', 'chunked');
    
    const archive = archiver('zip', { 
      zlib: { level: 1 }, // Reduced compression for speed and less RAM
      forceLocalTime: true,
      store: files.length > 200 // No compression for large galleries
    });

    archive.on('error', (err) => {
      console.error('ZIP-Archiv Fehler:', err);
      clearTimeout(timeout);
      if (!isResponseSent) {
        sendError(500, 'Fehler beim Erstellen der ZIP-Datei');
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
    isResponseSent = true;

    // Process files in smaller batches to control memory usage
    const batchSize = Math.max(3, Math.min(10, Math.floor(50 / Math.max(1, files.length / 100))));
    console.log(`Using batch size: ${batchSize}`);
    
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      
      // Process batch sequentially to control memory usage
      for (const file of batch) {
        try {
          const { data } = await drive.files.get(
            { fileId: file.id, alt: 'media' },
            { 
              responseType: 'stream',
              timeout: 60000 // 1 minute per file
            }
          );
          
          // Stream file directly into archive
          archive.append(data, { 
            name: file.path || file.name,
            date: new Date()
          });
          
          processedFiles++;
          if (processedFiles % 25 === 0) {
            console.log(`${processedFiles}/${files.length} Dateien verarbeitet (${Math.round(processedFiles/files.length*100)}%)`);
            
            // Force garbage collection hint
            if (global.gc) {
              global.gc();
            }
          }
        } catch (fileError) {
          console.error(`Fehler bei Datei ${file.name}:`, fileError.message);
        }
      }
      
      // Small delay between batches to prevent overwhelming the system
      if (i + batchSize < files.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log('Alle Dateien hinzugefügt, finalisiere ZIP...');
    archive.finalize();

    archive.on('end', () => {
      clearTimeout(timeout);
      console.log(`ZIP-Download abgeschlossen: ${processedFiles}/${files.length} Dateien`);
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

