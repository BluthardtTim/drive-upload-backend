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








app.get('/download-zip-testing', async (req, res) => {
  const folderId = req.query.folderId;
  const fileIds = req.query.fileIds; // Neue Parameter für ausgewählte Dateien
  
  if (!folderId) return res.status(400).json({ error: 'folderId fehlt' });

  let tmpPath;
  let isResponseSent = false;

  // Erhöhe Timeout für große Galerien (30 Minuten)
  const downloadTimeout = 30 * 60 * 1000; // 30 Minuten
  res.setTimeout(downloadTimeout);

  const sendError = (statusCode, message) => {
    if (!isResponseSent && !res.headersSent) {
      isResponseSent = true;
      res.status(statusCode).json({ error: message });
    } else {
      console.error(`Attempted to send error after headers sent: ${statusCode} - ${message}`);
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

    // Erweiterte Timeout-Behandlung basierend auf Anzahl der Dateien
    const timeoutDuration = Math.max(1800000, files.length * 4000); // Min 30min, 4s pro Datei für große Galerien
    const timeout = setTimeout(() => {
      console.error(`ZIP-Download Timeout nach ${timeoutDuration/1000}s für ${files.length} Dateien`);
      
      // (Keep-Alive Interval nicht mehr verwendet)
      
      cleanup();
      
      // Nur Error senden wenn noch möglich
      if (!isResponseSent && !res.headersSent) {
        sendError(408, 'Download-Timeout - Versuchen Sie es mit weniger Dateien');
      } else {
        console.error('Timeout occurred but headers already sent - closing connection');
        if (!res.destroyed) {
          res.destroy();
        }
      }
    }, timeoutDuration);

    tmpPath = path.join(os.tmpdir(), `folder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.zip`);
    const output = fs.createWriteStream(tmpPath);
    
    // Optimierte Archiver-Einstellungen für große Galerien
    const archive = archiver('zip', { 
      zlib: { level: files.length > 200 ? 1 : 6 }, // Weniger Kompression für große Galerien
      forceLocalTime: true,
      store: files.length > 100,
      gzip: false,
      statConcurrency: 1, // Limitiere gleichzeitige Operationen
      allowHalfOpen: false
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
    // Kleinere Batch-Größe für große Galerien um Memory-Probleme zu vermeiden
    const batchSize = files.length > 200 ? 3 : files.length > 100 ? 5 : 10;
    
    console.log(`Verarbeite ${files.length} Dateien in Batches von ${batchSize}`);
    
    // Setze Connection Keep-Alive Header am Anfang
    if (!res.headersSent) {
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Keep-Alive', 'timeout=1800, max=1000');
    }
    
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      
      // Sequenzielle Verarbeitung für große Galerien um Überlastung zu vermeiden
      if (files.length > 200) {
        for (const file of batch) {
          try {
            const { data } = await drive.files.get(
              { fileId: file.id, alt: 'media' },
              { 
                responseType: 'stream',
                timeout: 60000 // Erhöhtes Timeout für einzelne Dateien
              }
            );
            
            archive.append(data, { 
              name: file.path || file.name,
              date: new Date()
            });
            
            processedFiles++;
            if (processedFiles % 25 === 0) {
              console.log(`${processedFiles}/${files.length} Dateien verarbeitet (${Math.round(processedFiles/files.length*100)}%)`);
            }
          } catch (fileError) {
            console.error(`Fehler bei Datei ${file.name}:`, fileError.message);
            // Kontinuiere auch bei einzelnen Datei-Fehlern
          }
          
          // Kleine Pause zwischen Dateien für große Galerien
          if (files.length > 300) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      } else {
        // Parallele Verarbeitung für kleinere Galerien
        await Promise.all(batch.map(async (file) => {
          try {
            const { data } = await drive.files.get(
              { fileId: file.id, alt: 'media' },
              { 
                responseType: 'stream',
                timeout: 45000
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
      
      // Kleine Pause zwischen Batches für sehr große Galerien
      if (files.length > 500 && i + batchSize < files.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // Keep-Alive stoppen
    // (Nicht mehr benötigt da wir kein Interval verwenden)

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








app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
