// Updated Backend Code with Multi-ZIP Support for Railway
// This integrates the multi-zip functionality into your existing backend

import express from 'express';
import fileUpload from 'express-fileupload';
import cors from 'cors';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { Readable } from 'stream';
import archiver from 'archiver';
import { PassThrough } from 'stream';
import fs from 'fs';
import path from 'path';
import os from 'os';

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

// Make drive available to the app for multi-zip routes
app.set('drive', drive);

// Multi-ZIP Configuration
const CHUNK_SIZE = 200; // Images per ZIP part
const MAX_CONCURRENT_DOWNLOADS = 5;

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

// Function to create a single ZIP chunk
const createZipChunk = async (files, chunkIndex, totalChunks, galleryName) => {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(os.tmpdir(), `${galleryName}-part${chunkIndex + 1}-of-${totalChunks}-${Date.now()}.zip`);
    const output = fs.createWriteStream(tmpPath);
    const archive = archiver('zip', { 
      zlib: { level: 6 },
      forceLocalTime: true,
      store: false
    });

    let isFinalized = false;

    const cleanup = () => {
      if (fs.existsSync(tmpPath)) {
        fs.unlink(tmpPath, (err) => {
          if (err) console.error('Fehler beim Löschen der temporären Datei:', err);
        });
      }
    };

    archive.on('error', (err) => {
      console.error(`ZIP-Archiv Fehler für Teil ${chunkIndex + 1}:`, err);
      cleanup();
      reject(err);
    });

    output.on('error', (err) => {
      console.error(`Output Stream Fehler für Teil ${chunkIndex + 1}:`, err);
      cleanup();
      reject(err);
    });

    archive.pipe(output);

    // Timeout for individual ZIP creation
    const timeout = setTimeout(() => {
      if (!isFinalized) {
        console.error(`Timeout für ZIP-Teil ${chunkIndex + 1}`);
        cleanup();
        reject(new Error(`Timeout für ZIP-Teil ${chunkIndex + 1}`));
      }
    }, 180000); // 3 minutes per part

    // Process files in batches
    const processBatch = async (batch) => {
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
        } catch (fileError) {
          console.error(`Fehler bei Datei ${file.name} in Teil ${chunkIndex + 1}:`, fileError.message);
        }
      }));
    };

    // Process all files
    const processFiles = async () => {
      try {
        const batchSize = 5;
        for (let i = 0; i < files.length; i += batchSize) {
          const batch = files.slice(i, i + batchSize);
          await processBatch(batch);
          
          // Short pause between batches
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        console.log(`Alle ${files.length} Dateien für Teil ${chunkIndex + 1} hinzugefügt, finalisiere...`);
        archive.finalize();
        isFinalized = true;
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    output.on('close', () => {
      clearTimeout(timeout);
      console.log(`ZIP-Teil ${chunkIndex + 1} erstellt: ${archive.pointer()} bytes`);
      resolve({
        path: tmpPath,
        size: fs.statSync(tmpPath).size,
        filename: `${galleryName}-part${chunkIndex + 1}-of-${totalChunks}.zip`
      });
    });

    processFiles();
  });
};

// Multi-ZIP Download Route
app.get('/download-multi-zip', async (req, res) => {
  const folderId = req.query.folderId;
  const fileIds = req.query.fileIds;
  
  if (!folderId) {
    return res.status(400).json({ error: 'folderId fehlt' });
  }

  let allFiles = [];
  let galleryName = 'gallery';
  
  try {
    // Get gallery name for better filenames
    try {
      const folderInfo = await drive.files.get({
        fileId: folderId,
        fields: 'name'
      });
      galleryName = folderInfo.data.name.replace(/[<>:"/\\|?*]/g, "_");
    } catch (error) {
      console.warn('Konnte Gallery-Name nicht abrufen:', error.message);
    }

    // Collect files
    if (fileIds && fileIds.trim() !== '') {
      const selectedFileIds = fileIds.split(',').map(id => id.trim()).filter(id => id);
      console.log(`Multi-ZIP für ausgewählte Dateien: ${selectedFileIds.length}`);
      
      for (const fileId of selectedFileIds) {
        try {
          const fileInfo = await drive.files.get({
            fileId: fileId,
            fields: 'id, name, mimeType'
          });
          allFiles.push({
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
      allFiles = await listAllFilesRecursive(folderId);
    }

    if (!allFiles.length) {
      return res.status(404).json({ error: 'Keine Dateien gefunden' });
    }

    console.log(`Multi-ZIP Download gestartet für ${allFiles.length} Dateien`);

    // Check if multi-zip is necessary
    if (allFiles.length <= CHUNK_SIZE) {
      return res.status(400).json({ 
        error: 'Galerie ist zu klein für Multi-ZIP',
        suggestion: 'Verwenden Sie den normalen Download'
      });
    }

    // Split files into chunks
    const totalParts = Math.ceil(allFiles.length / CHUNK_SIZE);

    console.log(`Erstelle ${totalParts} ZIP-Teile mit max. ${CHUNK_SIZE} Dateien pro Teil`);

    // Send metadata to client
    res.json({
      success: true,
      totalFiles: allFiles.length,
      totalParts: totalParts,
      chunkSize: CHUNK_SIZE,
      galleryName: galleryName,
      downloadUrls: Array.from({ length: totalParts }, (_, index) => 
        `/download-zip-part?folderId=${encodeURIComponent(folderId)}&part=${index + 1}&total=${totalParts}&name=${encodeURIComponent(galleryName)}${fileIds ? `&fileIds=${encodeURIComponent(fileIds)}` : ''}`
      )
    });

  } catch (error) {
    console.error('Fehler in /download-multi-zip:', error);
    res.status(500).json({ error: 'Interner Fehler beim Multi-ZIP Download' });
  }
});

// Download individual ZIP part
app.get('/download-zip-part', async (req, res) => {
  const { folderId, part, total, name, fileIds } = req.query;
  
  if (!folderId || !part || !total) {
    return res.status(400).json({ error: 'Fehlende Parameter' });
  }

  const partIndex = parseInt(part) - 1;
  const totalParts = parseInt(total);
  const galleryName = name || 'gallery';

  let allFiles = [];
  let tmpFiles = [];

  const cleanup = () => {
    tmpFiles.forEach(tmpPath => {
      if (fs.existsSync(tmpPath)) {
        fs.unlink(tmpPath, (err) => {
          if (err) console.error('Fehler beim Cleanup:', err);
        });
      }
    });
  };

  try {
    // Collect files (same logic as above)
    if (fileIds && fileIds.trim() !== '') {
      const selectedFileIds = fileIds.split(',').map(id => id.trim()).filter(id => id);
      
      for (const fileId of selectedFileIds) {
        try {
          const fileInfo = await drive.files.get({
            fileId: fileId,
            fields: 'id, name, mimeType'
          });
          allFiles.push({
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
      allFiles = await listAllFilesRecursive(folderId);
    }

    // Extract chunk for this part
    const startIndex = partIndex * CHUNK_SIZE;
    const endIndex = Math.min(startIndex + CHUNK_SIZE, allFiles.length);
    const chunkFiles = allFiles.slice(startIndex, endIndex);

    if (!chunkFiles.length) {
      return res.status(404).json({ error: 'Keine Dateien in diesem Teil gefunden' });
    }

    console.log(`Erstelle ZIP-Teil ${part}/${total} mit ${chunkFiles.length} Dateien`);

    // Create ZIP part
    const zipResult = await createZipChunk(chunkFiles, partIndex, totalParts, galleryName);
    tmpFiles.push(zipResult.path);

    // Send ZIP file
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipResult.filename}"`);
    res.setHeader('Content-Length', zipResult.size);

    const fileStream = fs.createReadStream(zipResult.path);
    
    fileStream.on('error', (err) => {
      console.error('Fehler beim Senden der ZIP-Datei:', err);
      cleanup();
      if (!res.headersSent) {
        res.status(500).json({ error: 'Fehler beim Senden der ZIP-Datei' });
      }
    });

    fileStream.on('end', () => {
      console.log(`ZIP-Teil ${part}/${total} erfolgreich gesendet`);
      cleanup();
    });

    res.on('close', () => {
      console.log('Client-Verbindung geschlossen');
      cleanup();
    });

    fileStream.pipe(res);

  } catch (error) {
    console.error(`Fehler beim Erstellen von ZIP-Teil ${part}:`, error);
    cleanup();
    res.status(500).json({ error: `Fehler beim Erstellen von ZIP-Teil ${part}` });
  }
});

// Original ZIP-Download Route (unchanged for backward compatibility)
app.get('/download-zip', async (req, res) => {
  const folderId = req.query.folderId;
  const fileIds = req.query.fileIds;
  
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

// POST /rename-file
app.post('/rename-file', async (req, res) => {
    const { fileId, newName } = req.body;
    
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
  console.log(`Server läuft auf Port ${PORT} mit Multi-ZIP Support`);
});
