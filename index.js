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
  const fileIds = req.query.fileIds;
  
  if (!folderId) return res.status(400).json({ error: 'folderId fehlt' });

  let tmpPath;
  let isResponseSent = false;
  let progressInterval;

  const sendError = (statusCode, message) => {
    if (!isResponseSent) {
      isResponseSent = true;
      if (progressInterval) clearInterval(progressInterval);
      res.status(statusCode).json({ error: message });
    }
  };

  const cleanup = () => {
    if (progressInterval) clearInterval(progressInterval);
    if (tmpPath && fs.existsSync(tmpPath)) {
      fs.unlink(tmpPath, (err) => {
        if (err) console.error('Fehler beim Löschen der temporären Datei:', err);
      });
    }
  };

  // Set longer timeout for large galleries
  const timeout = setTimeout(() => {
    console.error('ZIP-Download Timeout nach 15 Minuten');
    cleanup();
    sendError(408, 'Download-Timeout - Galerie zu groß');
  }, 900000); // 15 Minuten statt 5

  try {
    console.log(`ZIP-Download gestartet für Ordner: ${folderId}`);
    
    let files;
    
    if (fileIds && fileIds.trim() !== '') {
      const selectedFileIds = fileIds.split(',').map(id => id.trim()).filter(id => id);
      console.log(`Ausgewählte Dateien: ${selectedFileIds.length}`);
      
      files = [];
      // Process file IDs in batches to avoid overwhelming the API
      const batchSize = 20;
      for (let i = 0; i < selectedFileIds.length; i += batchSize) {
        const batch = selectedFileIds.slice(i, i + batchSize);
        const batchPromises = batch.map(async (fileId) => {
          try {
            const fileInfo = await drive.files.get({
              fileId: fileId,
              fields: 'id, name, mimeType, size'
            });
            return {
              id: fileInfo.data.id,
              name: fileInfo.data.name,
              mimeType: fileInfo.data.mimeType,
              size: fileInfo.data.size,
              path: fileInfo.data.name
            };
          } catch (error) {
            console.warn(`Datei ${fileId} konnte nicht gefunden werden:`, error.message);
            return null;
          }
        });
        
        const batchResults = await Promise.all(batchPromises);
        files.push(...batchResults.filter(file => file !== null));
        
        // Small delay between batches to be gentle on the API
        if (i + batchSize < selectedFileIds.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } else {
      files = await listAllFilesRecursive(folderId);
    }
    
    if (!files.length) {
      clearTimeout(timeout);
      return sendError(404, 'Keine Dateien gefunden');
    }

    console.log(`${files.length} Dateien zum Download vorbereitet`);

    // Calculate total size for better progress tracking
    const totalSize = files.reduce((sum, file) => sum + (parseInt(file.size) || 0), 0);
    console.log(`Geschätzte Gesamtgröße: ${Math.round(totalSize / 1024 / 1024)}MB`);

    tmpPath = path.join(os.tmpdir(), `folder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.zip`);
    const output = fs.createWriteStream(tmpPath);
    
    // Optimierte Archiver-Einstellungen für große Downloads
    const archive = archiver('zip', { 
      zlib: { 
        level: files.length > 200 ? 3 : 6, // Weniger Kompression bei vielen Dateien
        chunkSize: 64 * 1024 // 64KB chunks
      },
      forceLocalTime: true,
      store: files.length > 500, // Keine Kompression bei sehr vielen Dateien
      allowHalfOpen: false
    });

    // Set keep-alive headers for long downloads
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=900, max=1000');

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
    let processedSize = 0;
    const batchSize = files.length > 100 ? 5 : 10; // Kleinere Batches bei vielen Dateien
    
    // Progress logging
    progressInterval = setInterval(() => {
      console.log(`Fortschritt: ${processedFiles}/${files.length} Dateien (${Math.round(processedSize / 1024 / 1024)}MB)`);
    }, 10000); // Alle 10 Sekunden

    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      
      await Promise.allSettled(batch.map(async (file, index) => {
        const maxRetries = 3;
        let attempt = 0;
        
        while (attempt < maxRetries) {
          try {
            const { data } = await drive.files.get(
              { fileId: file.id, alt: 'media' },
              { 
                responseType: 'stream',
                timeout: 60000, // 60 Sekunden pro Datei
                retry: true,
                retryDelay: 1000
              }
            );
            
            archive.append(data, { 
              name: file.path || file.name,
              date: new Date()
            });
            
            processedFiles++;
            processedSize += parseInt(file.size) || 0;
            
            if (processedFiles % 25 === 0) {
              console.log(`${processedFiles}/${files.length} Dateien verarbeitet (${Math.round(processedSize / 1024 / 1024)}MB)`);
            }
            break; // Success, exit retry loop
            
          } catch (fileError) {
            attempt++;
            console.error(`Versuch ${attempt} fehlgeschlagen für Datei ${file.name}:`, fileError.message);
            
            if (attempt >= maxRetries) {
              console.error(`Datei ${file.name} nach ${maxRetries} Versuchen übersprungen`);
              processedFiles++; // Count as processed even if failed
            } else {
              // Wait before retry
              await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
          }
        }
      }));
      
      // Längere Pause zwischen Batches bei großen Galerien
      if (i + batchSize < files.length && files.length > 100) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    console.log('Alle Dateien hinzugefügt, finalisiere ZIP...');
    clearInterval(progressInterval);
    archive.finalize();

    output.on('close', () => {
      clearTimeout(timeout);
      const finalSize = archive.pointer();
      console.log(`ZIP-Datei erstellt: ${Math.round(finalSize / 1024 / 1024)}MB`);
      
      if (!isResponseSent) {
        isResponseSent = true;
        
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="gallery.zip"');
        res.setHeader('Content-Length', fs.statSync(tmpPath).size);
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Accept-Ranges', 'bytes');
        
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
    clearTimeout(timeout);
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

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
